// lib/orchestrator.js
// The post-confirmation flow: assignment → Slack channel → ClickUp → notify.

import {
  createProjectChannel,
  postProjectKickoff,
  sendManagerPickMessage,
  notifyAttendeePersonally,
} from "./slack.js";
import { createProjectRecord } from "./db.js";
import { resolveAssignments } from "./roster.js";
import { createClickUpTickets } from "./clickup.js";
import { normalizeDeliverables } from "./extraction.js";

/**
 * @param confirmation  row from pending_confirmations: { id, payload, status }
 *   payload shape (CLAUDE.md §5):
 *   {
 *     meeting_id, project_name,
 *     deliverables: [{ team: "content"|"design"|"dev", task, owner_name }],
 *     due_dates, attendees: [{ name, slack_id, team }]
 *   }
 * @param opts.designerSlackId  set when resuming after a manager pick
 */
export async function runProjectCreation(confirmation, opts = {}) {
  const p = confirmation.payload;

  // Normalize ONCE here so every downstream consumer (assignment, ClickUp's
  // owners[i]<->deliverables[i] zip, notifications) sees the exact same
  // array — stored payloads can predate the extraction-normalization fix
  // and still carry deliverables as a JSON-string.
  p.deliverables = normalizeDeliverables(p.deliverables);

  // ── 1. Assignment (roster-backed 3-flow engine) ───────────────────────
  const assignment = await resolveAssignments(p, opts);

  // If 2+ designers and no pick yet → pause here, ask the design manager.
  if (assignment.needsManagerPick) {
    await sendManagerPickMessage(
      assignment.managerSlackId,
      p.project_name,
      confirmation.id,
      assignment.designerCandidates
    );
    return; // pipeline resumes when the manager clicks a button
  }

  // ── 2. Slack channel + invites — everyone who attended, PLUS anyone
  // freshly resolved as a deliverable owner even if they were never on the
  // call (e.g. "let Shweta take the video" — she gets invited too) ───────
  const inviteIds = new Set();
  (p.attendees || []).forEach((a) => { if (a.slack_id) inviteIds.add(a.slack_id); });
  assignment.owners.forEach((o) => { if (o.slack_id) inviteIds.add(o.slack_id); });
  const channelId = await createProjectChannel(p.project_name, Array.from(inviteIds));

  // ── 3. ClickUp parent + subtasks ───────────────────────────────────────
  const clickup = await createClickUpTickets(p, assignment.owners);

  // ── 4. Persist mapping ───────────────────────────────────────────────
  await createProjectRecord({
    meeting_id: p.meeting_id,
    project_name: p.project_name,
    clickup_task_id: clickup.parentTaskId,
    clickup_url: clickup.url,
    slack_channel_id: channelId,
  });

  // ── 5. Notify in the new channel — owners + everyone who attended ─────
  await postProjectKickoff(channelId, p.project_name, assignment.owners, clickup.url, p.attendees);

  // ── 6. Personal heads-up DM to everyone invited, with their specific
  // task(s) if they own any deliverable (someone can own more than one) ──
  const tasksBySlackId = new Map();
  assignment.owners.forEach((o) => {
    if (!o.slack_id) return;
    if (!tasksBySlackId.has(o.slack_id)) tasksBySlackId.set(o.slack_id, []);
    tasksBySlackId.get(o.slack_id).push(o.task);
  });
  for (const slackId of inviteIds) {
    try {
      await notifyAttendeePersonally(slackId, {
        projectName: p.project_name,
        channelId,
        task: tasksBySlackId.get(slackId)?.join("; "),
        clickupUrl: clickup.url,
      });
    } catch (err) {
      console.error(`[orchestrator] personal notify failed for ${slackId} (non-fatal)`, err);
    }
  }
}
