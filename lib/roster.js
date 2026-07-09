// lib/roster.js
// Role resolution (CLAUDE.md §4/5): match meeting attendees to the roster,
// then decide who owns each deliverable — the 3-flow assignment engine.
import { listRoster, getRosterMemberByEmail, createRosterMember, updateRosterMember } from "./db.js";
import { lookupUserByEmail } from "./slack.js";

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

function teamOwnerEntry(team, present, fullTeamRoster) {
  const owner = present[0] || byLowestTickets(fullTeamRoster);
  if (!owner) return null;
  return {
    team: team[0].toUpperCase() + team.slice(1),
    slack_id: owner.slack_id,
    name: owner.name,
    email: owner.email,
  };
}

/**
 * 3-flow assignment engine (CLAUDE.md §5 diagram):
 *   a) 2+ designers in the meeting, no pick yet -> ask the design manager
 *   b) 1 designer present -> auto-assign
 *   c) 0 designers present -> auto-assign by lowest open-ticket count
 * Content/dev: same present-in-meeting-first logic, falling back to lowest
 * ticket count — no manager-pick branch (the diagram's 3-flow is design-only).
 *
 * @param payload  the confirmed project: { attendees: [{name, slack_id, team}], ... }
 * @param opts.designerSlackId  set when resuming after a manager pick
 */
export async function resolveAssignments(payload, opts = {}) {
  const roster = await listRoster();
  const resolvedAttendees = (payload.attendees || []).filter((a) => a.slack_id);

  const designRoster = roster.filter((r) => r.team === "design");
  const contentRoster = roster.filter((r) => r.team === "content");
  const devRoster = roster.filter((r) => r.team === "dev");

  if (opts.designerSlackId) {
    const picked = designRoster.find((r) => r.slack_id === opts.designerSlackId);
    const designOwner = picked
      ? { team: "Design", slack_id: picked.slack_id, name: picked.name, email: picked.email }
      : { team: "Design", slack_id: opts.designerSlackId, name: "Picked designer" };
    return {
      needsManagerPick: false,
      owners: [
        teamOwnerEntry("content", resolvedAttendees.filter((a) => a.team === "content"), contentRoster),
        designOwner,
        teamOwnerEntry("dev", resolvedAttendees.filter((a) => a.team === "dev"), devRoster),
      ].filter(Boolean),
    };
  }

  const designPresentSlackIds = new Set(
    resolvedAttendees.filter((a) => a.team === "design").map((a) => a.slack_id)
  );
  const designPresent = designRoster.filter((r) => designPresentSlackIds.has(r.slack_id));

  if (designPresent.length >= 2) {
    // The design team lead is the roster row with no manager of their own.
    const lead = designRoster.find((r) => !r.manager);
    return {
      needsManagerPick: true,
      managerSlackId: lead?.slack_id,
      designerCandidates: designPresent.map((d) => ({ name: d.name, slack_id: d.slack_id })),
    };
  }

  return {
    needsManagerPick: false,
    owners: [
      teamOwnerEntry("content", resolvedAttendees.filter((a) => a.team === "content"), contentRoster),
      teamOwnerEntry("design", designPresent, designRoster),
      teamOwnerEntry("dev", resolvedAttendees.filter((a) => a.team === "dev"), devRoster),
    ].filter(Boolean),
  };
}
