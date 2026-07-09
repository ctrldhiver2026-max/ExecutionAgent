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

async function createTask({ name, parentId, assigneeId, dueDateText }) {
  const body = { name };
  if (parentId) body.parent = parentId;
  if (assigneeId) body.assignees = [assigneeId];
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

  // due_dates is a free-text summary (may be a whole sentence covering
  // several dates) and isn't reliably Date.parse-able — project_due_date is
  // the clean, single-date fallback for the parent task and any deliverable
  // that doesn't have its own due_date.
  const projectDueDateText = payload.project_due_date || payload.due_dates;
  const parent = await createTask({ name: payload.project_name || "Untitled project", dueDateText: projectDueDateText });

  const deliverables = Array.isArray(payload.deliverables) ? payload.deliverables : [];
  if (deliverables.length > MAX_SUBTASKS) {
    console.error(`[clickup] ${deliverables.length} deliverables exceeds cap of ${MAX_SUBTASKS} — creating only the first ${MAX_SUBTASKS}`);
  }

  for (let i = 0; i < Math.min(deliverables.length, MAX_SUBTASKS); i++) {
    const d = deliverables[i];
    if (!d || typeof d !== "object" || typeof d.task !== "string" || !d.task) {
      console.error("[clickup] skipping malformed deliverable at index", i);
      continue;
    }
    const owner = owners[i];
    // Email match first (exact identity), then exact display-name match —
    // covers people whose ClickUp email differs from their calendar/roster
    // email (seen live: Hari is hari.k@grexit.com in ClickUp).
    let assigneeId = owner?.email ? idByEmail.get(owner.email.toLowerCase()) : undefined;
    if (!assigneeId && owner?.name) assigneeId = idByName.get(normalizeName(owner.name));
    if (!assigneeId) {
      console.warn(`[clickup] no ClickUp member matched owner "${owner?.name}" <${owner?.email || "no email"}> — subtask "${d.task}" left unassigned`);
    }
    await createTask({
      name: `[${d.team}] ${d.task}`,
      parentId: parent.id,
      assigneeId,
      dueDateText: d.due_date || projectDueDateText,
    });
  }

  return { parentTaskId: parent.id, url: parent.url };
}
