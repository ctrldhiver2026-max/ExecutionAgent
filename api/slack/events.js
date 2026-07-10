// api/slack/events.js
// Slack Events API Request URL → https://execution-agent.vercel.app/api/slack/events
//
// Requires the `message.channels` event subscription + `channels:history`
// bot scope (Reinstall to Workspace after adding either).
//
// Review-approval flow (2026-07-10: buttons are the primary path, plain
// text still works as a fallback — see api/slack/interactivity.js for the
// button-click handlers, lib/reviewFlow.js for the shared close-out logic):
//   1. An assignee posts "@approver here's the landing page" (a link is
//      optional now — a mention alone is enough) in their project's
//      channel. If that channel is a tracked project AND the sender has
//      exactly one open ClickUp subtask there, we remember "this person is
//      expected to approve this subtask" (pending_reviews) and post an
//      "Approve" / "Add comments" button message.
//   2. The mentioned approver either clicks "Approve" (interactivity.js),
//      or posts a separate plain message like "Done" / "Looks good" /
//      "Approved" in THAT SAME channel (handled here) — either way closes
//      the subtask out, marks it complete in ClickUp, and confirms in the
//      channel (already has the whole team in it, so that's the "team gets
//      notified" step too).
import { verifySlackSignature, postMessage, sendReviewButtons } from "../../lib/slack.js";
import {
  getProjectByChannelId,
  getRosterMemberBySlackId,
  createPendingReview,
  getLatestPendingReview,
  getLatestPendingReviewForSubtask,
  completePendingReview,
  updateProjectStagePlan,
} from "../../lib/db.js";
import { findClickUpMemberIdByEmail, findOpenSubtaskForAssignee, setTaskComplete, addTaskComment } from "../../lib/clickup.js";
import { displayName, approvePendingReview } from "../../lib/reviewFlow.js";

export const config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// Slack auto-linkifies both mentions and URLs in event text:
// "<@U0123|name>" or "<@U0123>", and "<https://example.com|label>" or "<https://example.com>".
const MENTION_RE = /<@([A-Z0-9]+)(?:\|[^>]*)?>/;
const URL_RE = /<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/;
// Global variants of the above, for stripping Slack's markup out of a whole
// message so it reads naturally in a ClickUp comment (ClickUp doesn't
// understand Slack's <@id>/<url|label> syntax).
const MENTION_RE_G = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;
const URL_RE_G = /<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/g;

function cleanSlackText(text) {
  return text.replace(MENTION_RE_G, "@$1").replace(URL_RE_G, "$1").trim();
}

// Deliberately short, common phrases — a whole-message match (after
// stripping punctuation), not a substring search, so a longer sentence that
// happens to contain the word "done" ("I'm not done yet") doesn't misfire.
const APPROVAL_PHRASES = new Set([
  "done", "approved", "approve", "looks good", "lgtm",
  "good to go", "confirmed", "final", "all good", "ship it",
]);

function isApprovalMessage(text) {
  const normalized = text.trim().toLowerCase().replace(/[.!]+$/, "");
  return APPROVAL_PHRASES.has(normalized);
}

/** Plain-text "approved" reply — delegates to the same close-out logic the "Approve" button uses (lib/reviewFlow.js), so both paths behave identically. */
async function handleApproval(event, pending) {
  await approvePendingReview(pending, event.user, event.channel);
}

/**
 * Manager blanket-approval (2026-07-10): the project's Owner (dashboard's
 * held_by_id — defaults to whoever confirmed the project) can approve a
 * team's outstanding work with a bare "approved"/"done"/etc., no @mention
 * needed first. This is a fallback checked only when the targeted per-person
 * flow (handleApproval, via a pending_reviews row keyed to THIS sender)
 * doesn't match — so a specifically-tagged reviewer's approval still takes
 * precedence and only closes their own subtask.
 *
 * Since every team is assigned and can be worked in parallel (2026-07-10,
 * see lib/clickup.js's TEAM_ORDER comment), a bare "approved" with no target
 * is ambiguous the moment more than one team still has open work — this
 * only acts when EXACTLY ONE team has anything outstanding, same
 * refuse-to-guess rule lib/roster.js already uses for ambiguous name
 * matches. Returns false (falls through to handleReviewRequest) if the
 * sender isn't this project's Owner, nothing is open, or more than one team
 * still has open work (too ambiguous to auto-approve — use the targeted
 * @mention flow instead).
 */
async function handleManagerApproval(event) {
  const project = await getProjectByChannelId(event.channel).catch(() => null);
  if (!project || !project.held_by_id || !project.stage_plan) return false;

  const sender = await getRosterMemberBySlackId(event.user).catch(() => null);
  if (!sender || sender.id !== project.held_by_id) return false;

  const plan = project.stage_plan;
  if (!Array.isArray(plan.order)) return false;
  const teamsWithOpenWork = plan.order.filter((team) => plan.stages[team]?.subtasks?.some((s) => !s.done));
  if (teamsWithOpenWork.length !== 1) {
    if (teamsWithOpenWork.length > 1) {
      console.log(`[slack/events] "${event.text}" from project owner but ${teamsWithOpenWork.length} teams have open work — too ambiguous to auto-approve, use @mention instead`);
    }
    return false;
  }
  const targetTeam = teamsWithOpenWork[0];
  const openSubtasks = plan.stages[targetTeam].subtasks.filter((s) => !s.done);

  // Latency fix (live incident 2026-07-10, same reasoning as handleApproval):
  // process every open subtask in this stage concurrently, and within each
  // subtask run its independent ClickUp calls concurrently too, instead of
  // one long sequential chain — a multi-subtask stage could otherwise take
  // several seconds per subtask, stacking well past Slack's ~3s ack window.
  const approverName = sender.name || event.user;
  await Promise.all(openSubtasks.map(async (s) => {
    // Best-effort: if someone already shared a link for this specific
    // subtask via the targeted flow, pull that into the ClickUp comment and
    // consume the row so it doesn't linger as permanently "open".
    const shareContext = await getLatestPendingReviewForSubtask(s.subtask_id).catch(() => null);
    const commentLines = [`Approved via Slack by ${approverName}.`];
    if (shareContext?.share_text) commentLines.push(`Shared: ${shareContext.share_text}`);
    if (shareContext?.share_url) commentLines.push(`Link: ${shareContext.share_url}`);
    await Promise.all([
      addTaskComment(s.subtask_id, commentLines.join("\n")).catch((err) =>
        console.error(`[slack/events] ClickUp comment failed for subtask ${s.subtask_id} (non-fatal)`, err)
      ),
      setTaskComplete(s.subtask_id),
    ]);
    if (shareContext) await completePendingReview(shareContext.id).catch(() => null);
    s.done = true;
  }));
  plan.stages[targetTeam].status = "done";

  await Promise.all([
    updateProjectStagePlan(project.meeting_id, plan),
    postMessage(
      event.channel,
      `${targetTeam} approved`,
      [{
        type: "section",
        text: { type: "mrkdwn", text: `:white_check_mark: *${targetTeam}* approved by <@${event.user}> — marked complete.` },
      }]
    ),
  ]);
  return true;
}

async function handleReviewRequest(event) {
  const mentionMatch = event.text.match(MENTION_RE);
  const urlMatch = event.text.match(URL_RE);
  // A link is no longer required (2026-07-10) — "@stakeholder this is done,
  // please approve" should trigger the buttons just as much as one with a
  // link attached. A mention alone is a broader net (any message mentioning
  // a teammate in a tracked channel could match), but it's still scoped by
  // the sender-has-exactly-one-open-subtask check below, so it can't fire
  // for someone with nothing to review.
  if (!mentionMatch) return; // not a message aimed at anyone in particular

  const project = await getProjectByChannelId(event.channel);
  if (!project || !project.clickup_task_id) return; // not a tracked project channel

  const sender = await getRosterMemberBySlackId(event.user);
  if (!sender || !sender.email) {
    console.log(`[slack/events] review message from unresolvable sender ${event.user} — skipping`);
    return;
  }

  const clickupMemberId = await findClickUpMemberIdByEmail(sender.email);
  if (!clickupMemberId) {
    console.log(`[slack/events] sender ${sender.email} isn't a ClickUp list member — skipping review request`);
    return;
  }

  const subtask = await findOpenSubtaskForAssignee(project.clickup_task_id, clickupMemberId);
  if (!subtask) {
    console.log(`[slack/events] no single open subtask for ${sender.email} in project "${project.project_name}" — skipping (ambiguous or none)`);
    return;
  }

  // Live incident 2026-07-10: the same "share for review" message got
  // processed twice (message re-sent, or a delivery quirk), creating two
  // separate pending_reviews rows for the same subtask — not itself
  // harmful (getLatestPendingReview just uses whichever is newest), but
  // messy and confusing. If one's already open for this exact subtask,
  // don't create another — just re-post the acknowledgment so it's clear
  // the request was heard, without duplicating the tracking row.
  const alreadyPending = await getLatestPendingReviewForSubtask(subtask.id).catch(() => null);
  if (alreadyPending) {
    await postMessage(
      event.channel,
      `Still waiting on <@${alreadyPending.approver_slack_id}> to review "${subtask.name}"`,
      [{
        type: "section",
        text: { type: "mrkdwn", text: `:eyes: Already waiting on <@${alreadyPending.approver_slack_id}> for *${subtask.name}*.` },
      }]
    );
    return;
  }

  const approverSlackId = mentionMatch[1];
  // cleanSlackText alone leaves the approver's mention as a raw Slack id
  // ("@U0123") since it has no roster access — swap in their resolved name
  // so the eventual ClickUp comment reads naturally. Any other/unresolved
  // mentions in the message still fall back to the raw id, which is fine.
  const approverName = await displayName(approverSlackId);
  const shareText = cleanSlackText(event.text).replace(`@${approverSlackId}`, `@${approverName}`);
  const pending = await createPendingReview({
    channel_id: event.channel,
    subtask_id: subtask.id,
    subtask_name: subtask.name,
    assignee_slack_id: event.user,
    approver_slack_id: approverSlackId,
    share_text: shareText,
    share_url: urlMatch ? urlMatch[1] : null,
  });
  // Buttons are the primary path (2026-07-10); replying with a plain
  // "approved" still works too (isApprovalMessage/handleApproval, above) —
  // this is additive, not a replacement.
  await sendReviewButtons(event.channel, approverSlackId, subtask.name, pending.id);
}

async function handleChannelMessage(event) {
  // Only plain human messages — no edits/deletes/bot posts (avoids reacting
  // to our own acknowledgement/confirmation messages and looping).
  if (event.subtype || event.bot_id || !event.text || !event.user) return;

  // Check "is this an approval reply?" before "is this a new review
  // request?" — an approver's short "Done" would never contain a mention
  // or link anyway, but checking order matters if someone ever combines both.
  if (isApprovalMessage(event.text)) {
    const pending = await getLatestPendingReview(event.channel, event.user);
    if (pending) {
      await handleApproval(event, pending);
      return;
    }
    // Not tagged as the expected approver for anything specific — but the
    // project's Owner/manager can still approve the whole active stage
    // directly, no @mention required (see handleManagerApproval).
    const handledByManager = await handleManagerApproval(event).catch((err) => {
      console.error("[slack/events] manager approval failed (non-fatal)", err);
      return false;
    });
    if (handledByManager) return;
    // Neither matched — say nothing, not every "done" is ours.
  }

  await handleReviewRequest(event);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const rawBody = await readRawBody(req);
  const body = JSON.parse(rawBody);

  // Slack's URL verification handshake — must echo the challenge.
  // (Slack does NOT sign this consistently across retries in some setups,
  // so handle it before signature rejection.)
  if (body.type === "url_verification") {
    return res.status(200).json({ challenge: body.challenge });
  }

  if (!verifySlackSignature(req, rawBody)) {
    return res.status(401).json({ error: "invalid signature" });
  }

  // Slack retries an event if it doesn't get a response within ~3s — this
  // handler's ClickUp calls (list members, fetch every subtask) can run
  // long enough to trigger that on a bigger project, which would otherwise
  // post the same review prompt twice. Ack the retry without reprocessing,
  // same guard api/slack/interactivity.js already uses.
  if (req.headers["x-slack-retry-num"]) {
    return res.status(200).end();
  }

  // Await before acking (same reasoning as api/slack/interactivity.js —
  // Vercel Fluid compute tears the invocation down right after the
  // response flushes, silently dropping work queued after res.end()).
  if (body.event && body.event.type === "message") {
    try {
      await handleChannelMessage(body.event);
    } catch (err) {
      console.error("[slack/events] message handling failed (non-fatal)", err);
    }
  }

  res.status(200).end();
}
