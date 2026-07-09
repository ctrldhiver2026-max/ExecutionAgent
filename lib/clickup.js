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
function toDueDateMs(dueDateText) {
  if (!dueDateText) return null;
  const parsed = Date.parse(dueDateText);
  return Number.isNaN(parsed) ? null : parsed;
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
 * Parent task + one subtask per deliverable, assigned to the resolved owner
 * for that deliverable's team (matched to ClickUp by email).
 * @param payload  { project_name, deliverables: [{team, task}], due_dates }
 * @param owners   [{ team: "Content"|"Design"|"Dev", email, name }]
 */
export async function createClickUpTickets(payload, owners) {
  const members = await listMembers().catch((err) => {
    console.error("[clickup] listMembers failed, subtasks will be unassigned", err);
    return [];
  });
  const idByEmail = new Map(members.filter((m) => m.email).map((m) => [m.email.toLowerCase(), m.id]));
  const ownerByTeam = new Map(owners.map((o) => [o.team.toLowerCase(), o]));

  const parent = await createTask({ name: payload.project_name, dueDateText: payload.due_dates });

  for (const d of payload.deliverables || []) {
    const owner = ownerByTeam.get((d.team || "").toLowerCase());
    const assigneeId = owner?.email ? idByEmail.get(owner.email.toLowerCase()) : undefined;
    if (owner?.email && !assigneeId) {
      console.warn(`[clickup] no ClickUp member found for ${owner.email} — subtask "${d.task}" left unassigned`);
    }
    await createTask({
      name: `[${d.team}] ${d.task}`,
      parentId: parent.id,
      assigneeId,
      dueDateText: payload.due_dates,
    });
  }

  return { parentTaskId: parent.id, url: parent.url };
}
