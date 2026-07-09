// lib/db.js
// Minimal Supabase REST helpers (no SDK — plain fetch against PostgREST).
// Tables (per CLAUDE.md §2): pending_confirmations, projects, roster.

const SUPABASE_URL = process.env.SUPABASE_URL; // https://xxxx.supabase.co
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // service role key — server-side only

async function rest(path, { method = "GET", body, query = "" } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}${query}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    throw new Error(`Supabase ${method} ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/**
 * Store an extracted-but-unconfirmed project. Returns the row (with id).
 * Suggested columns: id uuid default gen_random_uuid(), payload jsonb,
 * status text default 'pending', created_at timestamptz default now()
 */
export async function createPendingConfirmation(payload) {
  const rows = await rest("pending_confirmations", {
    method: "POST",
    body: { payload, status: "pending" },
  });
  return rows[0];
}

export async function getPendingConfirmation(id) {
  const rows = await rest("pending_confirmations", {
    query: `?id=eq.${id}&select=*`,
  });
  return rows[0] || null;
}

export async function updateConfirmationStatus(id, status) {
  const rows = await rest("pending_confirmations", {
    method: "PATCH",
    body: { status },
    query: `?id=eq.${id}`,
  });
  return rows[0];
}

/** Persist the meeting → ClickUp → Slack channel mapping once the project is created. */
export async function createProjectRecord({ meeting_id, project_name, clickup_task_id, slack_channel_id }) {
  const rows = await rest("projects", {
    method: "POST",
    body: { meeting_id, project_name, clickup_task_id, slack_channel_id },
  });
  return rows[0];
}
