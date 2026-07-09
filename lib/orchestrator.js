// lib/orchestrator.js
// The post-confirmation flow: assignment → Slack channel → ClickUp → notify.
// Charan's pieces (assignment logic, ClickUp) are stubbed with clear seams
// so integration in Phase 3 is "replace the stub, keep the signature."

import {
  createProjectChannel,
  postProjectKickoff,
  sendManagerPickMessage,
} from "./slack.js";
import { createProjectRecord } from "./db.js";

/**
 * @param confirmation  row from pending_confirmations: { id, payload, status }
 *   payload shape (Mansoor's extraction output, per CLAUDE.md §5):
 *   {
 *     meeting_id, project_name,
 *     deliverables: [{ team: "content"|"design"|"dev", task, owner_name }],
 *     due_dates, attendees: [{ name, slack_id, team }]
 *   }
 * @param opts.designerSlackId  set when resuming after a manager pick
 */
export async function runProjectCreation(confirmation, opts = {}) {
  const p = confirmation.payload;

  // ── 1. Assignment (Charan's logic — stubbed) ─────────────────────────
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

  // ── 3. ClickUp parent + subtasks (Charan — stubbed) ──────────────────
  const clickup = await createClickUpTickets(p, assignment.owners);

  // ── 4. Persist mapping ───────────────────────────────────────────────
  await createProjectRecord({
    meeting_id: p.meeting_id,
    project_name: p.project_name,
    clickup_task_id: clickup.parentTaskId,
    clickup_url: clickup.url,
    slack_channel_id: channelId,
  });

  // ── 5. Notify in the new channel ─────────────────────────────────────
  await postProjectKickoff(channelId, p.project_name, assignment.owners, clickup.url);
}

// ─── STUBS: Charan replaces these in Phase 3 ───────────────────────────

/**
 * STUB — Charan's 3-flow assignment engine goes here.
 * Contract: returns either
 *   { needsManagerPick: true, managerSlackId, designerCandidates: [{name, slack_id}] }
 * or
 *   { needsManagerPick: false, owners: [{ team, slack_id, name }] }
 */
async function resolveAssignments(payload, opts) {
  if (opts.designerSlackId) {
    // Manager already picked — build owners with the chosen designer
    return {
      needsManagerPick: false,
      owners: [
        { team: "Content", slack_id: process.env.STUB_CONTENT_OWNER, name: "Content Owner" },
        { team: "Design", slack_id: opts.designerSlackId, name: "Picked Designer" },
        { team: "Dev", slack_id: process.env.STUB_DEV_OWNER, name: "Dev Owner" },
      ],
    };
  }

  // Hardcoded happy path for solo testing (flow b: 1 designer → auto-assign).
  // Set these env vars to real Slack user IDs in your workspace.
  return {
    needsManagerPick: false,
    owners: [
      { team: "Content", slack_id: process.env.STUB_CONTENT_OWNER, name: "Content Owner" },
      { team: "Design", slack_id: process.env.STUB_DESIGN_OWNER, name: "Design Owner" },
      { team: "Dev", slack_id: process.env.STUB_DEV_OWNER, name: "Dev Owner" },
    ],
  };
}

/** STUB — Charan's ClickUp parent+subtask creation. */
async function createClickUpTickets(payload, owners) {
  console.log("[stub] would create ClickUp tickets for", payload.project_name, owners);
  return {
    parentTaskId: "stub-task-id",
    url: "https://app.clickup.com/",
  };
}
