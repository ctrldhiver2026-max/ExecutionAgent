// lib/roster.js
// Role resolution (CLAUDE.md §4/5): match meeting attendees to the roster,
// then decide who owns each deliverable — the 3-flow assignment engine.
import { listRoster } from "./db.js";

function normalize(s) {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Match a captured attendee name against the roster by name (case-insensitive). */
export function matchRosterByName(name, roster) {
  const n = normalize(name);
  return roster.find((r) => normalize(r.name) === n) || null;
}

/**
 * Resolve raw captured attendee names into roster-backed identities.
 * Unmatched attendees are kept (name only) so they still display on the
 * dashboard/Slack DM, just without a slack_id (harmless — channel invite
 * filters those out).
 */
export async function resolveAttendees(attendeeNames = []) {
  const roster = await listRoster();
  return attendeeNames.map((name) => {
    const match = matchRosterByName(name, roster);
    return match
      ? { name: match.name, slack_id: match.slack_id, team: match.team, email: match.email }
      : { name };
  });
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
