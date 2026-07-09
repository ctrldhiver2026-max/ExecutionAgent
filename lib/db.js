// lib/db.js
// Minimal Supabase REST helpers (no SDK — plain fetch against PostgREST).
// Tables: pending_confirmations, projects, roster (CLAUDE.md §2), meetings
// (dashboard — schema in README.md §2).

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
 * Actual columns (verified against Supabase): id uuid, meeting_id text,
 * project_name text not null, extracted_json jsonb not null,
 * status text default 'pending', slack_thread_ts text, created_at timestamptz.
 * The full extraction payload lives in extracted_json; callers still see it
 * as `.payload` via normalize() below so orchestrator.js/interactivity.js
 * don't need to know about the column rename.
 */
export async function createPendingConfirmation(payload) {
  const rows = await rest("pending_confirmations", {
    method: "POST",
    body: {
      meeting_id: payload.meeting_id,
      project_name: payload.project_name,
      extracted_json: payload,
      status: "pending",
    },
  });
  return normalize(rows[0]);
}

export async function getPendingConfirmation(id) {
  const rows = await rest("pending_confirmations", {
    query: `?id=eq.${encodeURIComponent(id)}&select=*`,
  });
  return rows[0] ? normalize(rows[0]) : null;
}

function normalize(row) {
  return { ...row, payload: row.extracted_json };
}

export async function updateConfirmationStatus(id, status) {
  const rows = await rest("pending_confirmations", {
    method: "PATCH",
    body: { status },
    query: `?id=eq.${encodeURIComponent(id)}`,
  });
  return rows[0];
}

/** Persist the meeting → ClickUp → Slack channel mapping once the project is created. */
export async function createProjectRecord({ meeting_id, project_name, clickup_task_id, clickup_url, slack_channel_id }) {
  const rows = await rest("projects", {
    method: "POST",
    body: { meeting_id, project_name, clickup_task_id, clickup_url, slack_channel_id },
  });
  return rows[0];
}

/** Persist a captured meeting (transcript + extraction result; extracted is null when extraction failed). */
export async function createMeetingRecord({ meeting_id, ended_at, attendees, transcript, extracted }) {
  const rows = await rest("meetings", {
    method: "POST",
    body: { meeting_id, ended_at, attendees, transcript, extracted },
  });
  return rows[0];
}

/** Most recent meetings, newest first. Columns pinned to the dashboard
 * contract so future table additions are never exposed publicly. */
export async function listMeetings(limit = 25) {
  return rest("meetings", {
    query: `?select=id,meeting_id,created_at,ended_at,attendees,transcript,extracted&order=created_at.desc&limit=${limit}`,
  });
}
