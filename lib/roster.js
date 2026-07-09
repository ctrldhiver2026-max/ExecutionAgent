// lib/roster.js
// Role resolution (CLAUDE.md §4/5): match meeting attendees to the roster,
// then decide who owns each deliverable — the 3-flow assignment engine.
import { listRoster, getRosterMemberByEmail, createRosterMember, updateRosterMember } from "./db.js";
import { lookupUserByEmail, lookupUserByName } from "./slack.js";

export function normalize(s) {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Match a captured attendee name against the roster by name (case-insensitive). */
export function matchRosterByName(name, roster) {
  const n = normalize(name);
  return roster.find((r) => normalize(r.name) === n) || null;
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
    const slackUser = await lookupUserByEmail(email).catch((err) => {
      console.error(`[roster] Slack lookup failed for ${email} (non-fatal)`, err);
      return null;
    });
    row = await createRosterMember({
      name: slackUser?.name || name || email,
      email,
      slack_id: slackUser?.id || null,
      team: null, // unknown until inferred from this meeting or set in the dashboard
    });
    console.log(`[roster] new attendee: ${row.name} <${email}>${row.slack_id ? "" : " (no Slack account found)"}`);
  } else if (!row.slack_id) {
    // Seen before but never got a Slack ID (e.g. created before the scope
    // was granted) — retry now in case that's since been fixed.
    const slackUser = await lookupUserByEmail(email).catch(() => null);
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
  if (existing) return existing;

  const slackUser = await lookupUserByName(name).catch((err) => {
    console.error(`[roster] Slack name lookup failed for "${name}" (non-fatal)`, err);
    return null;
  });
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

  return Promise.all(
    attendeeNames.map(async (name) => {
      const email = emailByCalendarName.get(normalize(name));
      if (email) return getOrCreateAttendeeIdentity({ email, name });

      // No calendar email for this attendee (ad-hoc call, or their captured
      // name didn't match the invite) — fall back to matching by name.
      const match = matchRosterByName(name, roster);
      return match
        ? { id: match.id, name: match.name, slack_id: match.slack_id, team: match.team, email: match.email }
        : { name };
    })
  );
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
  const deliverables = payload.deliverables || [];
  const attendees = (payload.attendees || []).filter((a) => a.slack_id);

  const rosterByTeam = {
    content: roster.filter((r) => r.team === "content"),
    design: roster.filter((r) => r.team === "design"),
    dev: roster.filter((r) => r.team === "dev"),
  };
  const presentByTeam = {
    content: attendees.filter((a) => a.team === "content"),
    design: attendees.filter((a) => a.team === "design"),
    dev: attendees.filter((a) => a.team === "dev"),
  };

  // Manager-pick only triggers when some design deliverable is genuinely
  // ambiguous (no named owner) AND 2+ designers are actually on the call.
  const needsDesignPick =
    !opts.designerSlackId &&
    presentByTeam.design.length >= 2 &&
    deliverables.some((d) => d.team === "design" && !d.owner_name);

  if (needsDesignPick) {
    // The design team lead is the roster row with no manager of their own.
    const lead = rosterByTeam.design.find((r) => !r.manager);
    return {
      needsManagerPick: true,
      managerSlackId: lead?.slack_id,
      designerCandidates: presentByTeam.design.map((d) => ({ name: d.name, slack_id: d.slack_id })),
    };
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
