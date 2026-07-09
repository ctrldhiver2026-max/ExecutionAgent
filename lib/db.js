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

/** Single meeting row by id — needed to merge a rename into its extracted jsonb (PostgREST PATCH replaces the whole column, not one key). */
export async function getMeetingById(id) {
  const rows = await rest("meetings", {
    query: `?id=eq.${encodeURIComponent(id)}&select=id,meeting_id,extracted`,
  });
  return rows[0] || null;
}

/** Rewrite a meeting's extracted jsonb (dashboard rename control — display-only, does not touch ClickUp/Slack). */
export async function updateMeetingExtracted(id, extracted) {
  const rows = await rest("meetings", {
    method: "PATCH",
    body: { extracted },
    query: `?id=eq.${encodeURIComponent(id)}`,
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

/** Recent confirmation requests — dashboard workflow timeline. Columns
 * pinned: extracted_json stays server-side (may contain raw transcript). */
export async function listPendingConfirmations(limit = 50) {
  return rest("pending_confirmations", {
    query: `?select=id,meeting_id,project_name,status,created_at&order=created_at.desc&limit=${limit}`,
  });
}

/** Recent provisioned projects (channel + ClickUp mapping) — dashboard workflow timeline. */
export async function listProjects(limit = 50) {
  try {
    return await rest("projects", {
      query: `?select=meeting_id,project_name,clickup_task_id,clickup_url,slack_channel_id,held_by_id,created_at&order=created_at.desc&limit=${limit}`,
    });
  } catch (err) {
    // held_by_id is a new column (README's 2026-07-10 migration) — until
    // that's run, PostgREST 42703s on it and takes the WHOLE dashboard down
    // with it (seen live). Degrade instead of hard-failing: retry without
    // it so the timeline/confirmations keep working; Held-by just won't
    // show until the migration runs.
    if (String(err.message).includes("held_by_id")) {
      console.error("[db] projects.held_by_id missing (migration not run yet) — falling back without it");
      return rest("projects", {
        query: `?select=meeting_id,project_name,clickup_task_id,clickup_url,slack_channel_id,created_at&order=created_at.desc&limit=${limit}`,
      });
    }
    throw err;
  }
}

/** Look up which project a Slack channel belongs to — the review-approval flow needs this to know a channel message is even about a tracked project. */
export async function getProjectByChannelId(channel_id) {
  if (!channel_id) return null;
  const rows = await rest("projects", {
    query: `?slack_channel_id=eq.${encodeURIComponent(channel_id)}&select=meeting_id,project_name,clickup_task_id,slack_channel_id`,
  });
  return rows[0] || null;
}

/**
 * Review-approval flow (api/slack/events.js): when an assignee shares work
 * for review ("@approver here's the link"), we remember who's expected to
 * approve which subtask so a LATER, separate plain-text reply from that
 * approver ("Done" / "Approved") can be matched back to it — there's no
 * button carrying that context anymore, so it has to be persisted.
 * share_text/share_url capture what was actually shared (cleaned message +
 * extracted link) so the eventual ClickUp comment and dashboard timeline
 * entry have real content, not just a status flip. Degrades to the
 * pre-migration columns if share_text/share_url don't exist yet (2026-07-10
 * migration, see README) — same pattern as listProjects()'s held_by_id
 * fallback below.
 */
export async function createPendingReview({ channel_id, subtask_id, subtask_name, assignee_slack_id, approver_slack_id, share_text, share_url }) {
  try {
    const rows = await rest("pending_reviews", {
      method: "POST",
      body: { channel_id, subtask_id, subtask_name, assignee_slack_id, approver_slack_id, share_text, share_url },
    });
    return rows[0];
  } catch (err) {
    if (String(err.message).includes("share_text") || String(err.message).includes("share_url")) {
      console.error("[db] pending_reviews.share_text/share_url missing (migration not run yet) — creating without them");
      const rows = await rest("pending_reviews", {
        method: "POST",
        body: { channel_id, subtask_id, subtask_name, assignee_slack_id, approver_slack_id },
      });
      return rows[0];
    }
    throw err;
  }
}

/** Most recent NOT-YET-COMPLETED review in this channel awaiting approval from this specific person — first match wins since rows arrive newest-first. Falls back to the pre-migration query (no completed_at column, rows are deleted on approval so all remaining rows are implicitly open) if the migration hasn't run yet. */
export async function getLatestPendingReview(channel_id, approver_slack_id) {
  try {
    const rows = await rest("pending_reviews", {
      query: `?channel_id=eq.${encodeURIComponent(channel_id)}&approver_slack_id=eq.${encodeURIComponent(approver_slack_id)}&completed_at=is.null&select=*&order=created_at.desc&limit=1`,
    });
    return rows[0] || null;
  } catch (err) {
    if (String(err.message).includes("completed_at")) {
      const rows = await rest("pending_reviews", {
        query: `?channel_id=eq.${encodeURIComponent(channel_id)}&approver_slack_id=eq.${encodeURIComponent(approver_slack_id)}&select=*&order=created_at.desc&limit=1`,
      });
      return rows[0] || null;
    }
    throw err;
  }
}

/**
 * Mark a pending review approved instead of deleting it, so it survives to
 * show up in the dashboard timeline (listCompletedReviews) and so the
 * ClickUp comment step has share_text/share_url to read. Falls back to a
 * hard delete (the old behavior) if completed_at doesn't exist yet — a
 * completed review would otherwise stay "open" forever pre-migration and
 * wrongly match a later approval reply in the same channel.
 */
export async function completePendingReview(id) {
  try {
    const rows = await rest("pending_reviews", {
      method: "PATCH",
      body: { completed_at: new Date().toISOString() },
      query: `?id=eq.${encodeURIComponent(id)}`,
    });
    return rows[0] || null;
  } catch (err) {
    if (String(err.message).includes("completed_at")) {
      console.error("[db] pending_reviews.completed_at missing (migration not run yet) — deleting instead, no timeline/ClickUp-comment history");
      await rest("pending_reviews", { method: "DELETE", query: `?id=eq.${encodeURIComponent(id)}` });
      return null;
    }
    throw err;
  }
}

/** Approved reviews, newest first — dashboard timeline's "Task completed" entries. Returns [] pre-migration (no completed_at column means nothing is ever marked complete, only deleted) rather than erroring the whole pipeline status endpoint. */
export async function listCompletedReviews(limit = 100) {
  try {
    return await rest("pending_reviews", {
      query: `?completed_at=not.is.null&select=channel_id,subtask_id,subtask_name,assignee_slack_id,approver_slack_id,share_text,share_url,completed_at&order=completed_at.desc&limit=${limit}`,
    });
  } catch (err) {
    if (String(err.message).includes("completed_at")) {
      console.error("[db] pending_reviews.completed_at missing (migration not run yet) — no completed-review history available");
      return [];
    }
    throw err;
  }
}

/** Set who currently owns/drives a provisioned project (dashboard's "Held by" picker) — a manual field independent of deliverable owners, keyed by meeting_id since that's the stable link the dashboard already has. */
export async function updateProjectHeldBy(meeting_id, held_by_id) {
  const rows = await rest("projects", {
    method: "PATCH",
    body: { held_by_id: held_by_id || null },
    query: `?meeting_id=eq.${encodeURIComponent(meeting_id)}`,
  });
  return rows[0] || null;
}

/** Rename a provisioned project's display name to match a meeting rename — cosmetic only, does not touch the actual ClickUp task title or Slack channel name. No-op if no project row exists yet for this meeting. */
export async function updateProjectNameByMeetingId(meeting_id, project_name) {
  const rows = await rest("projects", {
    method: "PATCH",
    body: { project_name },
    query: `?meeting_id=eq.${encodeURIComponent(meeting_id)}`,
  });
  return rows[0] || null;
}

/** Delete a single meeting row (dashboard's per-card trash icon). */
export async function deleteMeeting(id) {
  await rest("meetings", { method: "DELETE", query: `?id=eq.${encodeURIComponent(id)}` });
}

/** Cascade: remove the project record created for this meeting, if any. */
export async function deleteProjectsByMeetingId(meeting_id) {
  if (!meeting_id) return;
  await rest("projects", { method: "DELETE", query: `?meeting_id=eq.${encodeURIComponent(meeting_id)}` });
}

/** Cascade: remove any pending/confirmed confirmation tied to this meeting. */
export async function deletePendingConfirmationsByMeetingId(meeting_id) {
  if (!meeting_id) return;
  await rest("pending_confirmations", { method: "DELETE", query: `?meeting_id=eq.${encodeURIComponent(meeting_id)}` });
}

/** Full reset — dashboard's "Clear all" button. Wipes every meeting, project,
 * and confirmation record. Does not touch roster (people are real, keep them). */
export async function deleteAllMeetingsData() {
  await rest("meetings", { method: "DELETE", query: "?id=not.is.null" });
  await rest("projects", { method: "DELETE", query: "?id=not.is.null" });
  await rest("pending_confirmations", { method: "DELETE", query: "?id=not.is.null" });
}

/** Calendar-watcher dedup: event ids we've already notified about.
 * Fetches recent rows and filters client-side — avoids PostgREST in.()
 * quoting/encoding pitfalls at hackathon scale. */
export async function getNotifiedEventIds() {
  const rows = await rest("calendar_notifications", {
    query: "?select=event_id&order=notified_at.desc&limit=500",
  });
  return new Set(rows.map((r) => r.event_id));
}

export async function markEventNotified(event_id, title, start_at) {
  await rest("calendar_notifications", {
    method: "POST",
    body: { event_id, title, start_at },
  });
}

/** Roll back a dedup mark when the Slack send fails, so the next poll retries. */
export async function unmarkEventNotified(event_id) {
  await rest("calendar_notifications", {
    method: "DELETE",
    query: `?event_id=eq.${encodeURIComponent(event_id)}`,
  });
}

/** Scheduled meetings the calendar watcher has picked up — dashboard "Upcoming" tab. */
export async function listCalendarNotifications(limit = 25) {
  return rest("calendar_notifications", {
    query: `?select=event_id,title,start_at,notified_at&order=start_at.desc&limit=${limit}`,
  });
}

/** Full roster — used for role resolution (lib/roster.js) and the dashboard's people editor. */
export async function listRoster() {
  return rest("roster", {
    query: "?select=id,name,email,slack_id,team,manager,active_ticket_count&order=name",
  });
}

/** Single roster row by email (exact match), or null. */
export async function getRosterMemberByEmail(email) {
  if (!email) return null;
  const rows = await rest("roster", {
    query: `?email=eq.${encodeURIComponent(email)}&select=id,name,email,slack_id,team,manager,active_ticket_count`,
  });
  return rows[0] || null;
}

/** Single roster row by Slack user id — used to identify who posted a message in a project channel. */
export async function getRosterMemberBySlackId(slack_id) {
  if (!slack_id) return null;
  const rows = await rest("roster", {
    query: `?slack_id=eq.${encodeURIComponent(slack_id)}&select=id,name,email,slack_id,team,manager,active_ticket_count`,
  });
  return rows[0] || null;
}

/** First time we see this person (by email) — create their roster row. */
export async function createRosterMember({ name, email, slack_id, team }) {
  const rows = await rest("roster", {
    method: "POST",
    body: { name, email, slack_id: slack_id || null, team: team || null, active_ticket_count: 0 },
  });
  return rows[0];
}

/** Patch specific fields on an existing roster row, targeted by id. */
export async function updateRosterMember(id, fields) {
  const rows = await rest("roster", {
    method: "PATCH",
    body: fields,
    query: `?id=eq.${encodeURIComponent(id)}`,
  });
  return rows[0];
}
