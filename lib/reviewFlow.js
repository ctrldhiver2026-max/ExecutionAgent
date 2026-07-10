// lib/reviewFlow.js
// Shared "close out a pending review" logic (2026-07-10) used by BOTH ways
// an approver can approve a subtask: replying with a plain-text phrase like
// "approved" (api/slack/events.js) and clicking the "Approve" button
// (api/slack/interactivity.js). Same outcome either way — one place to fix
// bugs or tune latency instead of two copies drifting apart.
import { postMessage } from "./slack.js";
import { getRosterMemberBySlackId, completePendingReview, getProjectByChannelId, updateProjectStagePlan } from "./db.js";
import { addTaskComment, setTaskComplete } from "./clickup.js";

/** Roster display name for a Slack user id, falling back to the raw id if unresolved. Plain text, not Slack mention markup — the only consumer is ClickUp comments, which don't render <@id>. */
export async function displayName(slackId) {
  const member = await getRosterMemberBySlackId(slackId).catch(() => null);
  return member?.name || slackId;
}

/**
 * Completion tracking: marks the just-approved subtask done in the project's
 * stage_plan and, once every subtask in its team is done, flips that team's
 * status to "done" — purely for the dashboard Timeline / the manager
 * blanket-approval flow's "which team still has open work" check. No-op if
 * there's no stage_plan (pre-migration) or the subtask isn't tracked in it.
 *
 * Known limitation: stage_plan is read-modified-written as a single JSON
 * blob, so two approvals landing at the exact same moment could race and
 * one's `done` flag could be lost. Acceptable at this app's scale (a
 * handful of people approving one at a time) — not worth the complexity of
 * optimistic locking for a hackathon project.
 */
export async function advanceStageIfComplete(project, doneSubtaskId) {
  const plan = project?.stage_plan;
  if (!plan || !Array.isArray(plan.order) || !plan.stages) return;

  let currentTeam = null;
  for (const team of plan.order) {
    const subtask = plan.stages[team]?.subtasks?.find((s) => s.subtask_id === doneSubtaskId);
    if (subtask) {
      subtask.done = true;
      currentTeam = team;
      break;
    }
  }
  if (!currentTeam) return; // this subtask isn't tracked by the stage plan

  const currentStage = plan.stages[currentTeam];
  if (currentStage.subtasks.every((s) => s.done)) currentStage.status = "done";
  await updateProjectStagePlan(project.meeting_id, plan);
}

/**
 * Close out one pending review: ClickUp comment + status complete, mark the
 * review row completed, post the Slack confirmation, update stage tracking.
 * Latency-optimized (live incident 2026-07-10: the original sequential
 * version measured 3.6s+, past Slack's ~3s webhook ack window) — comment +
 * status-complete run together (setTaskComplete's success is NOT caught, so
 * a failure still aborts before completePendingReview, preserving "a review
 * is only marked complete if ClickUp actually is"), then completePendingReview
 * + the Slack post + the project fetch run together too.
 *
 * @param pending  pending_reviews row (subtask_id, subtask_name, share_text,
 *   share_url, assignee_slack_id, id)
 * @param approverSlackId  who approved it (may differ from pending.approver_slack_id
 *   if e.g. the project Owner approves via a different path later)
 * @param channelId  where to post the confirmation
 */
export async function approvePendingReview(pending, approverSlackId, channelId) {
  const [approverName, assigneeName] = await Promise.all([
    displayName(approverSlackId),
    pending.assignee_slack_id ? displayName(pending.assignee_slack_id) : null,
  ]);
  const commentLines = [`Approved via Slack by ${approverName}.`];
  if (pending.share_text) commentLines.push(`Shared${assigneeName ? ` by ${assigneeName}` : ""}: ${pending.share_text}`);
  if (pending.share_url) commentLines.push(`Link: ${pending.share_url}`);

  await Promise.all([
    addTaskComment(pending.subtask_id, commentLines.join("\n")).catch((err) =>
      console.error(`[reviewFlow] ClickUp comment failed for subtask ${pending.subtask_id} (non-fatal)`, err)
    ),
    setTaskComplete(pending.subtask_id),
  ]);

  const [, , project] = await Promise.all([
    completePendingReview(pending.id),
    postMessage(
      channelId,
      `"${pending.subtask_name}" approved`,
      [{
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:white_check_mark: *${pending.subtask_name}* approved by <@${approverSlackId}> — marked complete.`,
        },
      }]
    ),
    getProjectByChannelId(channelId).catch(() => null),
  ]);

  await advanceStageIfComplete(project, pending.subtask_id).catch((err) =>
    console.error(`[reviewFlow] stage tracking update failed for subtask ${pending.subtask_id} (non-fatal)`, err)
  );
}
