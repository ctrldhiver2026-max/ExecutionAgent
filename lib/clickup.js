// lib/clickup.js
// ClickUp REST API (plain fetch — repo convention, no SDK).
// Creates the parent task + one subtask per deliverable, matching owners to
// ClickUp's numeric user ids via the list's member roster (assignment by
// email isn't supported by ClickUp's task-create API — only numeric ids).

const CLICKUP_API = "https://api.clickup.com/api/v2";
const API_TOKEN = process.env.CLICKUP_API_TOKEN;
const LIST_ID = process.env.CLICKUP_LIST_ID;

async function clickupFetch(path, opts = {}) {
  if (!API_TOKEN || !LIST_ID) {
    throw new Error("ClickUp not configured (CLICKUP_API_TOKEN / CLICKUP_LIST_ID)");
  }
  const res = await fetch(`${CLICKUP_API}${path}`, {
    ...opts,
    headers: { Authorization: API_TOKEN, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`ClickUp ${path} failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

/** { id, username, email }[] for everyone with access to the list. */
export async function listMembers() {
  const data = await clickupFetch(`/list/${LIST_ID}/member`);
  return data.members || [];
}

// Extraction's due_dates is free text ("before the 25th") — best-effort
// parse; skip setting a date rather than guessing wrong if it doesn't resolve.
// Date.parse chokes on ordinal suffixes (verified live: "August 15th" ->
// NaN, "August 15" -> parses fine) even though the extraction prompt asks
// for exactly the "August 15th" phrasing — strip st/nd/rd/th before parsing.
function toDueDateMs(dueDateText) {
  if (!dueDateText) return null;
  let cleaned = dueDateText.replace(/(\d+)(st|nd|rd|th)\b/gi, "$1").trim();

  // A bare "Month Day" with no year (the normal case — meetings say "August
  // 15th", never "August 15th 2026") parses in V8 as year 2001, not the
  // current year (verified live) — always pin an explicit year ourselves.
  const hasYear = /\b\d{4}\b/.test(cleaned);
  const currentYear = new Date().getFullYear();
  if (!hasYear) cleaned = `${cleaned} ${currentYear}`;

  let parsed = Date.parse(cleaned);
  if (Number.isNaN(parsed)) return null;

  // If the date we just pinned to the current year is well in the past,
  // the meeting almost certainly meant next year (e.g. a "January 15th"
  // deadline discussed in November) — project due dates are never historical.
  if (!hasYear && parsed < Date.now() - 60 * 24 * 60 * 60 * 1000) {
    const nextYear = Date.parse(cleaned.replace(String(currentYear), String(currentYear + 1)));
    if (!Number.isNaN(nextYear)) parsed = nextYear;
  }

  return parsed;
}

async function createTask({ name, parentId, assigneeIds, dueDateText }) {
  const body = { name };
  if (parentId) body.parent = parentId;
  if (assigneeIds && assigneeIds.length) body.assignees = assigneeIds;
  const dueMs = toDueDateMs(dueDateText);
  if (dueMs) body.due_date = dueMs;
  const data = await clickupFetch(`/list/${LIST_ID}/task`, { method: "POST", body: JSON.stringify(body) });
  return { id: data.id, url: data.url };
}

/**
 * Parent task + one subtask per deliverable, each assigned to ITS OWN
 * resolved owner (matched to ClickUp by email) — not one shared owner per
 * team, since two deliverables on the same team can have different owners.
 * @param payload  { project_name, deliverables: [{team, task, due_date}], due_dates, project_due_date }
 *   Each deliverable's own due_date wins for its subtask; project_due_date
 *   is the parent task's date and every subtask's fallback when it has none
 *   of its own; due_dates (free text) is the last-resort fallback only.
 * @param owners   [{ task, team, email, name, slack_id }] — same length and
 *   order as payload.deliverables (lib/roster.js resolveAssignments builds
 *   it that way), zipped by index rather than matched by team.
 */
// Backstop against runaway loops: no real meeting produces this many
// deliverables. (Live incident 2026-07-09: a string iterated char-by-char
// tried to create hundreds of subtasks before dying on rate limits.)
const MAX_SUBTASKS = 25;

// Sequential department handoff (2026-07-10): only the first team in this
// order gets its subtasks assigned at creation time; everyone else's
// subtasks exist in ClickUp from day one (so the whole plan is visible) but
// sit unassigned until their turn — see lib/orchestrator.js's stage_plan and
// api/slack/events.js's stage-advancement logic for how a team gets
// activated once the team ahead of it is fully approved.
export const TEAM_ORDER = ["content", "design", "dev", "video_design"];

function normalizeName(s) {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

export async function createClickUpTickets(payload, owners) {
  const members = await listMembers().catch((err) => {
    console.error("[clickup] listMembers failed, subtasks will be unassigned", err);
    return [];
  });
  const idByEmail = new Map(members.filter((m) => m.email).map((m) => [m.email.toLowerCase(), m.id]));
  const idByName = new Map(members.filter((m) => m.username).map((m) => [normalizeName(m.username), m.id]));

  const deliverables = Array.isArray(payload.deliverables) ? payload.deliverables : [];
  if (deliverables.length > MAX_SUBTASKS) {
    console.error(`[clickup] ${deliverables.length} deliverables exceeds cap of ${MAX_SUBTASKS} — creating only the first ${MAX_SUBTASKS}`);
  }
  const cappedDeliverables = deliverables.slice(0, MAX_SUBTASKS);

  // Resolve every deliverable's assignee up front (pure lookup against the
  // member list already fetched, no extra API calls) so the parent task can
  // be assigned to everyone actually on the project, not left with no
  // assignees at all — seen live: the parent task showed empty in ClickUp
  // even though every subtask had someone assigned.
  const resolvedAssigneeIds = cappedDeliverables.map((d, i) => {
    if (!d || typeof d !== "object" || typeof d.task !== "string" || !d.task) return null;
    const owner = owners[i];
    // Email match first (exact identity), then exact display-name match —
    // covers people whose ClickUp email differs from their calendar/roster
    // email (seen live: Hari is hari.k@grexit.com in ClickUp).
    let assigneeId = owner?.email ? idByEmail.get(owner.email.toLowerCase()) : undefined;
    if (!assigneeId && owner?.name) assigneeId = idByName.get(normalizeName(owner.name));
    if (!assigneeId) {
      console.warn(`[clickup] no ClickUp member matched owner "${owner?.name}" <${owner?.email || "no email"}> — subtask "${d.task}" left unassigned`);
    }
    return assigneeId || null;
  });
  const parentAssigneeIds = Array.from(new Set(resolvedAssigneeIds.filter(Boolean)));

  // Which team goes first: the earliest team in TEAM_ORDER that actually has
  // a deliverable. A deliverable whose team isn't one of the 4 known ones
  // (shouldn't happen — roster.team has a DB check constraint for exactly
  // these — but extraction output isn't a hard guarantee) is treated as
  // part of the first/active stage rather than silently stuck pending
  // forever with no team ahead of it that could ever unblock it.
  const presentTeams = TEAM_ORDER.filter((team) => cappedDeliverables.some((d) => d?.team === team));
  const firstTeam = presentTeams[0];

  // due_dates is a free-text summary (may be a whole sentence covering
  // several dates) and isn't reliably Date.parse-able — project_due_date is
  // the clean, single-date fallback for the parent task and any deliverable
  // that doesn't have its own due_date.
  const projectDueDateText = payload.project_due_date || payload.due_dates;
  const parent = await createTask({
    name: payload.project_name || "Untitled project",
    assigneeIds: parentAssigneeIds,
    dueDateText: projectDueDateText,
  });

  const subtasks = [];
  for (let i = 0; i < cappedDeliverables.length; i++) {
    const d = cappedDeliverables[i];
    if (!d || typeof d !== "object" || typeof d.task !== "string" || !d.task) {
      console.error("[clickup] skipping malformed deliverable at index", i);
      continue;
    }
    const assigneeId = resolvedAssigneeIds[i];
    // Active (first-stage or unrecognized-team) subtasks get assigned now;
    // everyone else's subtask still gets created — so the full plan is
    // visible in ClickUp immediately — but stays unassigned until their
    // team's turn (see stage-advancement in api/slack/events.js).
    const isActiveStage = !presentTeams.includes(d.team) || d.team === firstTeam;
    const created = await createTask({
      name: `[${d.team}] ${d.task}`,
      parentId: parent.id,
      assigneeIds: isActiveStage && assigneeId ? [assigneeId] : undefined,
      dueDateText: d.due_date || projectDueDateText,
    });
    const owner = owners[i];
    subtasks.push({
      team: d.team,
      subtaskId: created.id,
      subtaskName: `[${d.team}] ${d.task}`,
      assigneeId: assigneeId || null,
      assigneeSlackId: owner?.slack_id || null,
      assigneeName: owner?.name || null,
      assigneeEmail: owner?.email || null,
      activated: isActiveStage,
    });
  }

  return { parentTaskId: parent.id, url: parent.url, subtasks };
}

/**
 * Fetch a parent task's subtasks with full detail (assignees, due date,
 * status) — ClickUp's include_subtasks=true only returns stub {id}s, so
 * each one needs its own GET. Shared by getProjectLiveStatus and the
 * review-approval flow (findOpenSubtaskForAssignee) so both see the same
 * live ClickUp state through one code path.
 */
async function fetchSubtaskDetails(parentTaskId) {
  const parent = await clickupFetch(`/task/${parentTaskId}?include_subtasks=true`);
  const stubs = Array.isArray(parent.subtasks) ? parent.subtasks : [];
  const subtasks = (
    await Promise.all(
      stubs.map((s) =>
        clickupFetch(`/task/${s.id}`).catch((err) => {
          console.error(`[clickup] failed to fetch subtask ${s.id} (non-fatal)`, err);
          return null;
        })
      )
    )
  ).filter(Boolean);

  return subtasks.map((t) => ({
    id: t.id,
    name: t.name,
    dueDate: t.due_date ? Number(t.due_date) : null,
    // ClickUp status.type is "open" | "custom" | "closed" — "closed" is the
    // only value that means done, verified against this list's own statuses
    // (to do -> open, in progress -> custom, complete -> closed).
    done: t.status?.type === "closed",
    assignees: t.assignees || [], // [{id, username, email}]
  }));
}

/**
 * Live project status for the dashboard's "Project Status" panel — computed
 * on demand from ClickUp itself (not stored anywhere) so it's always
 * current: on-track means no subtask is both past its due date AND still
 * open, and "assigned" is who ClickUp actually has on each subtask right
 * now (reassignments in ClickUp show up here with no extra plumbing).
 * @param parentTaskId  payload.clickup_task_id from the projects table.
 */
export async function getProjectLiveStatus(parentTaskId) {
  const details = await fetchSubtaskDetails(parentTaskId);
  const now = Date.now();

  const overdue = details.filter((t) => !t.done && t.dueDate && t.dueDate < now);
  const assignees = Array.from(new Set(details.flatMap((t) => t.assignees.map((a) => a.username).filter(Boolean))));

  return {
    onTrack: overdue.length === 0,
    overdueTasks: overdue.map((t) => t.name),
    assignees,
    subtaskCount: details.length,
    doneCount: details.filter((t) => t.done).length,
  };
}

/**
 * The Slack "someone shared their finished work" flow needs to know WHICH
 * subtask a channel message is about. We don't ask the sender to specify —
 * instead, find the one subtask in this project that's both (a) currently
 * assigned in ClickUp to them and (b) not already done. Returns null (skip
 * automation entirely) if that's not exactly one subtask, since guessing
 * wrong would close/notify about the wrong deliverable.
 */
export async function findOpenSubtaskForAssignee(parentTaskId, clickupMemberId) {
  const details = await fetchSubtaskDetails(parentTaskId);
  const candidates = details.filter((t) => !t.done && t.assignees.some((a) => a.id === clickupMemberId));
  if (candidates.length !== 1) return null;
  return { id: candidates[0].id, name: candidates[0].name };
}

/** { id, username, email } for a ClickUp list member matching this email, or null. */
export async function findClickUpMemberIdByEmail(email) {
  if (!email) return null;
  const members = await listMembers().catch(() => []);
  const match = members.find((m) => m.email && m.email.toLowerCase() === email.toLowerCase());
  return match ? match.id : null;
}

// The list's one "done" status, cached — looked up live instead of
// hardcoding a name like "complete" since a list's status names/wording
// aren't guaranteed (this one happens to use to do/in progress/complete).
let cachedClosedStatusName = null;
async function getClosedStatusName() {
  if (cachedClosedStatusName) return cachedClosedStatusName;
  const data = await clickupFetch(`/list/${LIST_ID}`);
  const closed = (data.statuses || []).find((s) => s.type === "closed");
  cachedClosedStatusName = closed ? closed.status : "complete";
  return cachedClosedStatusName;
}

/** Move a subtask to the list's closed/"done" status — the review-approval flow's Yes action. */
export async function setTaskComplete(taskId) {
  const statusName = await getClosedStatusName();
  await clickupFetch(`/task/${taskId}`, { method: "PUT", body: JSON.stringify({ status: statusName }) });
}

/**
 * Assign a task that was created without one — the sequential department
 * handoff's "activate the next stage" step. NOTE: updating an existing
 * task's assignees uses a different body shape than creating one
 * (`{assignees: [id]}` at creation vs `{assignees: {add: [...], rem: []}}`
 * on update) — verified live against a real disposable task before wiring
 * this in, since ClickUp's API isn't consistent between create and update.
 */
export async function assignTask(taskId, assigneeId) {
  await clickupFetch(`/task/${taskId}`, {
    method: "PUT",
    body: JSON.stringify({ assignees: { add: [assigneeId], rem: [] } }),
  });
}

/**
 * Post a comment on a task — the review-approval flow uses this to leave a
 * record of what was actually shared (the message + link) and who approved
 * it, since flipping the status alone gives no context to anyone opening the
 * ClickUp task later.
 */
export async function addTaskComment(taskId, commentText) {
  await clickupFetch(`/task/${taskId}/comment`, {
    method: "POST",
    body: JSON.stringify({ comment_text: commentText }),
  });
}
