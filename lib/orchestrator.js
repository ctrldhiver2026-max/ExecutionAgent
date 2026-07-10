// lib/orchestrator.js
// The post-confirmation flow: assignment → Slack channel → ClickUp → notify.

import {
  createProjectChannel,
  postProjectKickoff,
  sendManagerPickMessage,
  notifyAttendeePersonally,
} from "./slack.js";
import { createProjectRecord, getRosterMemberBySlackId } from "./db.js";
import { resolveAssignments } from "./roster.js";
import { createClickUpTickets, TEAM_ORDER } from "./clickup.js";
import { normalizeDeliverables } from "./extraction.js";

/**
 * Turn createClickUpTickets()'s flat per-deliverable subtask list into the
 * sequential department handoff's persisted state: which teams are involved
 * (in TEAM_ORDER, filtered to teams actually present), and each team's
 * subtasks + done/active/pending status. The first present team starts
 * "active" (already assigned, per createClickUpTickets) — everyone else
 * starts "pending" (subtask exists, unassigned) until api/slack/events.js
 * activates them on approval. Returns null if there's nothing to stage
 * (no deliverables, or none with a recognized team) — a single-team project
 * still gets a plan, it just has nowhere to advance to.
 */
export function buildStagePlan(subtasks) {
  const order = TEAM_ORDER.filter((team) => subtasks.some((s) => s.team === team));
  if (!order.length) return null;

  const stages = {};
  order.forEach((team, idx) => {
    stages[team] = {
      status: idx === 0 ? "active" : "pending",
      subtasks: subtasks
        .filter((s) => s.team === team)
        .map((s) => ({
          subtask_id: s.subtaskId,
          subtask_name: s.subtaskName,
          assignee_id: s.assigneeId,
          assignee_slack_id: s.assigneeSlackId,
          assignee_name: s.assigneeName,
          assignee_email: s.assigneeEmail,
          done: false,
        })),
    };
  });

  // A deliverable whose team isn't one of the 4 known ones (shouldn't
  // happen, but extraction output isn't a hard guarantee) was created
  // already-assigned by createClickUpTickets — fold it into the first
  // stage so it's still tracked instead of quietly dropped from the plan.
  const unrecognized = subtasks.filter((s) => !order.includes(s.team));
  stages[order[0]].subtasks.push(
    ...unrecognized.map((s) => ({
      subtask_id: s.subtaskId,
      subtask_name: s.subtaskName,
      assignee_id: s.assigneeId,
      assignee_slack_id: s.assigneeSlackId,
      assignee_name: s.assigneeName,
      assignee_email: s.assigneeEmail,
      done: false,
    }))
  );

  return { order, stages };
}

/**
 * @param confirmation  row from pending_confirmations: { id, payload, status }
 *   payload shape (CLAUDE.md §5):
 *   {
 *     meeting_id, project_name,
 *     deliverables: [{ team: "content"|"design"|"dev"|"video_design", task, owner_name, due_date }],
 *     due_dates, project_due_date, attendees: [{ name, slack_id, team }]
 *   }
 * @param opts.designerSlackId  set when resuming after a manager pick
 * @param opts.initiatorSlackId  whoever clicked Yes on the confirm DM —
 *   becomes the project's default Owner (dashboard's held_by_id)
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

  // ── 3. ClickUp parent + subtasks (only the first department's subtasks
  // get assigned now — the rest wait for their turn, see buildStagePlan) ──
  const clickup = await createClickUpTickets(p, assignment.owners);

  // ── 4. Persist mapping ───────────────────────────────────────────────
  const initiator = opts.initiatorSlackId
    ? await getRosterMemberBySlackId(opts.initiatorSlackId).catch(() => null)
    : null;
  await createProjectRecord({
    meeting_id: p.meeting_id,
    project_name: p.project_name,
    clickup_task_id: clickup.parentTaskId,
    clickup_url: clickup.url,
    slack_channel_id: channelId,
    held_by_id: initiator?.id || null,
    stage_plan: buildStagePlan(clickup.subtasks || []),
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
