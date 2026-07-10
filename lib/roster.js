// lib/roster.js
// Role resolution (CLAUDE.md §4/5): match meeting attendees to the roster,
// then decide who owns each deliverable — the 3-flow assignment engine.
import { listRoster, getRosterMemberByEmail, createRosterMember, updateRosterMember } from "./db.js";
import { lookupUserByEmail, lookupUserByName } from "./slack.js";

// The company renamed grexit.com -> hiverhq.com; Slack profiles and calendar
// invites don't all agree on which domain a given person uses, so the same
// local-part can need either domain depending on which system last touched
// that person's record. Try the other domain before giving up on email entirely.
const RENAMED_DOMAINS = ["grexit.com", "hiverhq.com"];

function swapDomain(email) {
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  const other = RENAMED_DOMAINS.find((d) => d !== domain && RENAMED_DOMAINS.includes(domain));
  return other ? `${local}@${other}` : null;
}

/**
 * Email lookup first (exact identity when it hits), then the same local-part
 * under the company's other historical domain (grexit.com <-> hiverhq.com),
 * then falling back to an exact name match — covers every way the calendar
 * invite's email can fail to correspond to the Slack account directly.
 */
async function lookupUserByEmailThenName(email, name) {
  const byEmail = await lookupUserByEmail(email).catch((err) => {
    console.error(`[roster] Slack email lookup failed for ${email} (non-fatal)`, err);
    return null;
  });
  if (byEmail) return byEmail;

  const altEmail = swapDomain(email);
  if (altEmail) {
    const byAltEmail = await lookupUserByEmail(altEmail).catch((err) => {
      console.error(`[roster] Slack email lookup failed for ${altEmail} (non-fatal)`, err);
      return null;
    });
    if (byAltEmail) return byAltEmail;
  }

  if (!name) return null;
  return lookupUserByName(name).catch((err) => {
    console.error(`[roster] Slack name fallback failed for "${name}" (non-fatal)`, err);
    return null;
  });
}
import { normalizeDeliverables } from "./extraction.js";

export function normalize(s) {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Standard edit distance — used only for the spelling-variant tier below, on short first-name-length strings, so cost is negligible. */
function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/** Match a captured attendee name against the roster by name (case-insensitive). */
export function matchRosterByName(name, roster) {
  const n = normalize(name);
  if (!n) return null;
  const exact = roster.find((r) => normalize(r.name) === n);
  if (exact) return exact;

  // Either side can be a first-name-only reference to the other's fuller
  // name: a meeting can name someone by first name only while the roster
  // has their full name ("Shweta" captured, roster has "Shweta B") — OR
  // the roster can only have a first name while the meeting used the full
  // name (live incident 2026-07-10: roster had "Aveeva", the transcript
  // captured "Aveeva Saikia" — the original one-directional check, roster
  // row's first word vs the WHOLE captured name, only covered the first
  // case and missed this one entirely). Comparing first-word-to-first-word
  // handles both directions symmetrically. Only trusted when unique, same
  // safety rule as the exact-name check above.
  const nFirst = n.split(" ")[0];
  const firstNameMatches = roster.filter((r) => normalize(r.name).split(" ")[0] === nFirst);
  if (firstNameMatches.length === 1) return firstNameMatches[0];
  if (firstNameMatches.length > 1) {
    console.log(`[roster] "${name}" matches multiple roster rows by first name — refusing to guess`);
    return null;
  }

  // Spelling-variant fallback (live incident 2026-07-10: extraction heard
  // "Aviva", the roster already had "Aveeva" — an existing, fully-resolved
  // person with a real email/Slack ID — and the exact/first-name tiers
  // above both missed it, so a dead duplicate roster row got created
  // instead of reusing her). Compares first words on both sides too (same
  // reasoning as above), only trusted when exactly ONE roster row is close
  // (distance <= 2, on names of comparable length) — same refuse-to-guess
  // rule as the tier above, so this can't misfire on two genuinely
  // different short names.
  if (nFirst.length >= 4) {
    const close = roster.filter((r) => {
      const rn = normalize(r.name).split(" ")[0];
      if (!rn || rn.length < 4 || Math.abs(rn.length - nFirst.length) > 2) return false;
      return levenshtein(rn, nFirst) <= 2;
    });
    if (close.length === 1) {
      console.log(`[roster] "${name}" fuzzy-matched to existing roster row "${close[0].name}" (spelling variant)`);
      return close[0];
    }
    if (close.length > 1) {
      console.log(`[roster] "${name}" fuzzy-matches multiple roster rows — refusing to guess`);
    }
  }
  return null;
}

/**
 * Zero-touch identity resolution: given a real email (from the calendar
 * invite), find or create their roster row and make sure it has a Slack ID —
 * looked up live via Slack (requires the users:read.email bot scope), never
 * typed in by hand. Write-through: a resolved slack_id is cached onto the
 * roster row so future meetings for the same person skip the Slack call.
 */
export async function getOrCreateAttendeeIdentity({ email, name }) {
  if (!email) return { name: name || "Unknown" };

  let row = await getRosterMemberByEmail(email);

  if (!row) {
    const slackUser = await lookupUserByEmailThenName(email, name);
    row = await createRosterMember({
      // Prefer the calendar/Meet-facing name over the Slack profile name:
      // roster.name is the KEY future Meet captures match against, and the
      // two often differ (verified live: Meet shows "Hari krishnan", his
      // Slack real_name is "Hari K" — storing the Slack name would break
      // every future ad-hoc name match for him).
      name: name || slackUser?.name || email,
      email,
      slack_id: slackUser?.id || null,
      team: null, // unknown until inferred from this meeting or set in the dashboard
    });
    console.log(`[roster] new attendee: ${row.name} <${email}>${row.slack_id ? "" : " (no Slack account found)"}`);
  } else if (!row.slack_id) {
    // Seen before but never got a Slack ID (e.g. created before the scope
    // was granted, or the email never matched a Slack account) — retry now,
    // falling back to a name match in case that's the real reason.
    const slackUser = await lookupUserByEmailThenName(email, name || row.name);
    if (slackUser?.id) row = await updateRosterMember(row.id, { slack_id: slackUser.id });
  }

  return { id: row.id, name: row.name, email: row.email, slack_id: row.slack_id, team: row.team };
}

/**
 * Find-or-create by NAME ONLY, for someone the meeting names as a task
 * owner but who was never actually on the call — so there's no email to
 * resolve them from (e.g. "let Shweta take the video", Shweta never
 * joined). Checks the existing roster by name first; if genuinely new,
 * tries an exact Slack display-name match (zero-touch when it hits) before
 * falling back to a name-only row that shows up in the dashboard's People
 * tab needing a manual email/Slack link.
 */
export async function getOrCreateRosterMemberByName(name, teamHint, roster) {
  const existing = matchRosterByName(name, roster);
  if (existing) {
    // Seen before but never got a Slack ID (e.g. the exact-match lookup
    // missed a spelling variant that now resolves, or was never retried) —
    // retry now instead of leaving them permanently unassignable.
    if (!existing.slack_id) {
      const retry = await lookupUserByName(existing.name || name).catch(() => null);
      if (retry?.id) {
        const updated = await updateRosterMember(existing.id, { slack_id: retry.id });
        Object.assign(existing, updated);
      }
    }
    return existing;
  }

  const slackUser = await lookupUserByName(name).catch((err) => {
    console.error(`[roster] Slack name lookup failed for "${name}" (non-fatal)`, err);
    return null;
  });
  // Same person may already exist under a different name spelling — reuse
  // their row instead of creating a duplicate with the same slack_id.
  if (slackUser?.id) {
    const bySlackId = roster.find((r) => r.slack_id === slackUser.id);
    if (bySlackId) return bySlackId;
  }
  // A failed insert (e.g. roster.email NOT NULL constraint before the
  // migration in README runs) must never kill the pipeline — degrade to a
  // non-persisted identity that still carries the Slack ID for
  // invites/DMs/assignment in THIS run.
  try {
    const row = await createRosterMember({
      name: slackUser?.name || name,
      email: null,
      slack_id: slackUser?.id || null,
      team: teamHint || null,
    });
    console.log(
      `[roster] new person mentioned but not on the call: ${row.name}` +
        (row.slack_id ? " (matched to Slack by name)" : " (no Slack match — needs email in the People tab)")
    );
    return row;
  } catch (err) {
    console.error(`[roster] could not persist roster row for "${name}" (non-fatal — using transient identity)`, err);
    return { name: slackUser?.name || name, email: null, slack_id: slackUser?.id || null, team: teamHint || null };
  }
}

/**
 * Resolve meeting attendees into roster-backed identities.
 * `attendeeNames` (the extension's actual capture) is always the ground
 * truth for WHO ATTENDED — a calendar invite lists who was invited, not who
 * showed up. `calendarAttendees` only supplies a real email for a captured
 * name, which feeds getOrCreateAttendeeIdentity for zero-guessing, auto-
 * discovering identity resolution. When no calendar email matches a
 * captured name (ad-hoc call, or a name that didn't line up with the
 * invite), falls back to matching that name against the roster directly.
 *
 * @param calendarAttendees  [{name, email}] from the correlated calendar
 *   event (lib/google.js findEventByMeetCode) — pass [] if unavailable.
 */
export async function resolveAttendees(attendeeNames = [], calendarAttendees = []) {
  // Ground truth for WHO ATTENDED is always attendeeNames (the extension's
  // actual capture) — a calendar invite lists who was invited, which is not
  // the same as who showed up. Calendar data is only used to supply a real
  // email for a name that was actually captured, never to add extra people.
  const emailByCalendarName = new Map(
    calendarAttendees.filter((a) => a.name && a.email).map((a) => [normalize(a.name), a.email])
  );

  const roster = await listRoster(); // single fetch, reused for every fallback lookup below

  // Dedupe by normalized name up front, and resolve SEQUENTIALLY — the
  // find-or-create steps below mutate shared state (roster rows), and
  // running them concurrently lets two spellings of the same person race
  // past the existence checks and insert duplicate rows.
  const uniqueNames = [...new Map(attendeeNames.map((n) => [normalize(n), n])).values()];

  const resolved = [];
  for (const name of uniqueNames) {
    const email = emailByCalendarName.get(normalize(name));
    if (email) {
      resolved.push(await getOrCreateAttendeeIdentity({ email, name }));
      continue;
    }

    // No calendar email for this attendee (ad-hoc call, or their captured
    // name didn't match the invite) — fall back to matching by name.
    const match = matchRosterByName(name, roster);
    if (match) {
      resolved.push({ id: match.id, name: match.name, slack_id: match.slack_id, team: match.team, email: match.email });
      continue;
    }

    // Last resort for ad-hoc meetings: exact Slack display-name match.
    // Meet display names usually equal Slack real names for workspace
    // members, so this keeps the zero-touch promise even with no calendar
    // invite. Only persists when Slack CONFIRMS the person exists — a
    // garbled caption name ("Sharon" for "Charan") gets no Slack hit and
    // stays a name-only attendee instead of polluting the roster.
    const slackUser = await lookupUserByName(name).catch(() => null);
    if (slackUser?.id) {
      // Different spelling of someone already in the roster? Reuse them.
      const bySlackId = roster.find((r) => r.slack_id === slackUser.id);
      if (bySlackId) {
        resolved.push({ id: bySlackId.id, name: bySlackId.name, slack_id: bySlackId.slack_id, team: bySlackId.team, email: bySlackId.email });
        continue;
      }
      try {
        const row = await createRosterMember({ name: slackUser.name, email: null, slack_id: slackUser.id, team: null });
        roster.push(row);
        console.log(`[roster] ad-hoc attendee resolved via Slack name match: ${row.name}`);
        resolved.push({ id: row.id, name: row.name, slack_id: row.slack_id, team: row.team, email: row.email });
      } catch (err) {
        // Insert failed (e.g. NOT NULL email constraint pre-migration) —
        // still usable this run via a transient identity; never fatal.
        console.error(`[roster] could not persist ad-hoc attendee "${name}" (non-fatal)`, err);
        resolved.push({ name: slackUser.name, slack_id: slackUser.id, email: null, team: null });
      }
      continue;
    }
    resolved.push({ name });
  }
  return resolved;
}

/**
 * Best-effort role inference (CLAUDE.md's "identify role from the meeting"):
 * if a deliverable names an owner and that resolved attendee has no team yet,
 * tag them with the deliverable's team. Mutates the matching entries in
 * `resolvedAttendees` in place so this meeting's own assignment step sees it
 * immediately, not just future meetings. Anyone left with team: null after
 * this needs a manual pick — see the dashboard's People section.
 */
export async function inferMissingTeams(resolvedAttendees, deliverables = []) {
  for (const d of deliverables) {
    if (!d.team || !d.owner_name) continue;
    const attendee = resolvedAttendees.find((a) => a.id && !a.team && normalize(a.name) === normalize(d.owner_name));
    if (!attendee) continue;
    try {
      const updated = await updateRosterMember(attendee.id, { team: d.team });
      attendee.team = updated.team;
      console.log(`[roster] inferred team for ${attendee.name}: ${d.team} (from "${d.task}")`);
    } catch (err) {
      console.error(`[roster] team inference failed for ${attendee.name} (non-fatal)`, err);
    }
  }
}

/** Roster member with a matching email — used to find the meeting organizer/manager. */
export async function findRosterMemberByEmail(email) {
  if (!email) return null;
  const roster = await listRoster();
  const target = normalize(email);
  return roster.find((r) => normalize(r.email) === target) || null;
}

function byLowestTickets(members) {
  return [...members].sort((a, b) => (a.active_ticket_count ?? 0) - (b.active_ticket_count ?? 0))[0] || null;
}

/**
 * Assignment engine — resolves ONE OWNER PER DELIVERABLE (not one owner per
 * team). A meeting can have several people on the same team with different
 * tasks — e.g. content covers both "webinar copy" (owner: you) and "video"
 * (owner: someone delegated the job who was never even on the call) — a
 * single content-team owner would wrongly swallow both.
 *
 * Per deliverable:
 *   1. owner_name given -> match against resolved attendees (fast path),
 *      else the full roster by name, else auto-create them (works even if
 *      they were never on the call — see getOrCreateRosterMemberByName).
 *   2. owner_name null, team === "design", 2+ designers actually on the
 *      call -> ask the design lead to pick (CLAUDE.md §5's 3-flow). Applies
 *      per-poll, not per-deliverable: one pick covers every unnamed design
 *      deliverable in this project.
 *   3. owner_name null otherwise -> whoever from that team is present on
 *      the call, else lowest open-ticket count across that team's roster.
 *
 * @param payload  the confirmed project: { deliverables: [{team, task,
 *   owner_name}], attendees: [{name, slack_id, team}], ... }
 * @param opts.designerSlackId  set when resuming after a manager pick
 */
export async function resolveAssignments(payload, opts = {}) {
  const roster = await listRoster();
  // Re-normalize even though ingest already did: payloads are stored
  // verbatim in pending_confirmations, so a row created before the
  // normalization fix (or by an older deploy) can still arrive here with
  // deliverables as a JSON-string — which, unguarded, gets iterated
  // character by character (the "hundreds of undefined ClickUp subtasks"
  // incident, 2026-07-09).
  const deliverables = normalizeDeliverables(payload.deliverables);
  const attendees = (Array.isArray(payload.attendees) ? payload.attendees : []).filter((a) => a && a.slack_id);

  const rosterByTeam = {
    content: roster.filter((r) => r.team === "content"),
    design: roster.filter((r) => r.team === "design"),
    dev: roster.filter((r) => r.team === "dev"),
    video_design: roster.filter((r) => r.team === "video_design"),
  };
  const presentByTeam = {
    content: attendees.filter((a) => a.team === "content"),
    design: attendees.filter((a) => a.team === "design"),
    dev: attendees.filter((a) => a.team === "dev"),
    video_design: attendees.filter((a) => a.team === "video_design"),
  };

  // Manager-pick only triggers when some design deliverable is genuinely
  // ambiguous (no named owner) AND 2+ designers are actually on the call.
  const needsDesignPick =
    !opts.designerSlackId &&
    presentByTeam.design.length >= 2 &&
    deliverables.some((d) => d.team === "design" && !d.owner_name);

  if (needsDesignPick) {
    // The design team lead is the roster row with no manager of their own —
    // requiring a slack_id so a name-only auto-created row can't shadow the
    // real lead. If no pickable manager exists at all, DON'T take this
    // branch: sendManagerPickMessage(undefined) would throw after the
    // confirmation is already marked confirmed, permanently sticking the
    // project. Fall through to auto-assign instead (CLAUDE.md cut-list #1).
    const managerSlackId =
      rosterByTeam.design.find((r) => !r.manager && r.slack_id)?.slack_id ||
      process.env.MANAGER_SLACK_ID ||
      null;
    if (managerSlackId) {
      return {
        needsManagerPick: true,
        managerSlackId,
        designerCandidates: presentByTeam.design.map((d) => ({ name: d.name, slack_id: d.slack_id })),
      };
    }
    console.log("[roster] 2+ designers present but no resolvable manager — falling back to auto-assign");
  }

  const pickedDesigner = opts.designerSlackId
    ? rosterByTeam.design.find((r) => r.slack_id === opts.designerSlackId) ||
      { slack_id: opts.designerSlackId, name: "Picked designer", email: null }
    : null;

  const owners = [];
  for (const d of deliverables) {
    const team = d.team;
    let owner = null;

    if (d.owner_name) {
      owner = attendees.find((a) => normalize(a.name) === normalize(d.owner_name));
      if (!owner) {
        // `roster` is a fetch-once snapshot but the same non-attendee name
        // (e.g. "Shweta") can own multiple deliverables in one meeting —
        // push newly-created rows back in so the second mention finds her
        // instead of creating a duplicate roster row.
        owner = await getOrCreateRosterMemberByName(d.owner_name, team, roster);
        if (!roster.some((r) => r.id === owner.id)) roster.push(owner);
      }
    } else if (team === "design" && pickedDesigner) {
      owner = pickedDesigner;
    } else {
      owner = (presentByTeam[team] || [])[0] || byLowestTickets(rosterByTeam[team] || []);
    }

    owners.push({
      task: d.task,
      team,
      slack_id: owner?.slack_id || null,
      name: owner?.name || d.owner_name || "Unassigned",
      email: owner?.email || null,
    });
  }

  return { needsManagerPick: false, owners };
}
