// lib/orchestrator.js
// The post-confirmation flow: assignment → Slack channel → ClickUp → notify.

import {
  createProjectChannel,
  postProjectKickoff,
  sendManagerPickMessage,
} from "./slack.js";
import { createProjectRecord } from "./db.js";
import { resolveAssignments } from "./roster.js";
import { createClickUpTickets } from "./clickup.js";

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

  // ── 2. Slack channel + invites ───────────────────────────────────────
  const attendeeIds = (p.attendees || []).map((a) => a.slack_id).filter(Boolean);
  const channelId = await createProjectChannel(p.project_name, attendeeIds);

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
}
