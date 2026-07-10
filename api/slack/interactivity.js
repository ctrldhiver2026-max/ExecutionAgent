// api/slack/interactivity.js
// Slack Interactivity Request URL → https://execution-agent.vercel.app/api/slack/interactivity
// Slack sends button clicks here as application/x-www-form-urlencoded with a `payload` field.

import { verifySlackSignature, slackApi, postMessage, openReviewCommentModal } from "../../lib/slack.js";
import { getPendingConfirmation, updateConfirmationStatus, getPendingReviewById } from "../../lib/db.js";
import { runProjectCreation } from "../../lib/orchestrator.js";
import { approvePendingReview, displayName } from "../../lib/reviewFlow.js";
import { addTaskComment } from "../../lib/clickup.js";

// Vercel: disable body parsing so we can verify the raw body signature.
export const config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const rawBody = await readRawBody(req);
  if (!verifySlackSignature(req, rawBody)) {
    return res.status(401).json({ error: "invalid signature" });
  }

  // payload is urlencoded: payload=<json>
  const params = new URLSearchParams(rawBody);
  const payload = JSON.parse(params.get("payload"));

  // Slack retries the same interaction if it doesn't get a response in
  // time (marked with this header) — applies to both button clicks and
  // modal submissions, so check it before branching on payload type.
  if (req.headers["x-slack-retry-num"]) {
    return res.status(200).end();
  }

  // Modal submission ("Add comments") — a completely different payload
  // shape from a button click (payload.type === "view_submission", no
  // payload.actions array), so it has to be handled before the
  // block_actions branch below or it'd just hit the "no action" early return.
  if (payload.type === "view_submission" && payload.view?.callback_id === "review_comment_modal") {
    try {
      const { pendingReviewId, channelId } = JSON.parse(payload.view.private_metadata || "{}");
      const commentText = payload.view.state?.values?.comment_block?.comment_input?.value?.trim();
      const pending = pendingReviewId ? await getPendingReviewById(pendingReviewId) : null;
      if (pending && commentText) {
        const commenterName = await displayName(payload.user.id);
        await Promise.all([
          postMessage(
            channelId,
            `Feedback on "${pending.subtask_name}"`,
            [{
              type: "section",
              text: { type: "mrkdwn", text: `:speech_balloon: <@${payload.user.id}> on *${pending.subtask_name}*:\n${commentText}` },
            }]
          ),
          addTaskComment(pending.subtask_id, `Feedback from ${commenterName} (via Slack):\n${commentText}`).catch((err) =>
            console.error(`[interactivity] ClickUp comment failed for subtask ${pending.subtask_id} (non-fatal)`, err)
          ),
        ]);
      }
    } catch (err) {
      console.error("[interactivity] review comment submission failed (non-fatal)", err);
    }
    // Empty 200 closes the modal — no response_action needed for a
    // straightforward single-input form with nothing left to validate.
    return res.status(200).end();
  }

  const action = payload.actions?.[0];
  if (!action) return res.status(200).end();

  // ── DO THE WORK, THEN ACK ────────────────────────────────────────────
  // Slack requires a response within 3s. We used to ack first and keep
  // working after res.end() — on Vercel's Fluid compute the invocation
  // tears down right after the response flushes, silently dropping any
  // work queued after it (confirmed via logs: 0 outgoing requests, 40ms).
  // So: await everything, respond once at the end. The whole flow (a
  // couple Supabase round trips + a couple Slack API calls) normally
  // finishes well under 3s; production would use a queue instead.
  try {
    if (action.action_id === "confirm_project") {
      const confirmation = await getPendingConfirmation(action.value);
      if (!confirmation || confirmation.status !== "pending") {
        await replaceMessage(payload, ":warning: This confirmation was already handled.");
        return res.status(200).end();
      }
      await updateConfirmationStatus(action.value, "confirmed");
      await replaceMessage(payload, `:white_check_mark: Confirmed! Setting up *${confirmation.payload.project_name}*…`);

      // Hand off to the pipeline: assignment → channel → ClickUp → notify.
      // payload.user.id is whoever clicked Yes — the project's default Owner.
      await runProjectCreation(confirmation, { initiatorSlackId: payload.user.id });
      return res.status(200).end();
    }

    if (action.action_id === "reject_project") {
      await updateConfirmationStatus(action.value, "rejected");
      await replaceMessage(payload, ":no_entry_sign: Got it — ignoring this one.");
      return res.status(200).end();
    }

    if (action.action_id.startsWith("pick_designer_")) {
      const [confirmationId, designerSlackId] = action.value.split("|");
      const confirmation = await getPendingConfirmation(confirmationId);
      if (!confirmation) return res.status(200).end();

      await replaceMessage(payload, `:art: Designer picked: <@${designerSlackId}>. Continuing setup…`);

      // Resume the pipeline with the chosen designer
      await runProjectCreation(confirmation, { designerSlackId });
      return res.status(200).end();
    }

    if (action.action_id === "review_approve") {
      const pending = await getPendingReviewById(action.value);
      if (!pending || pending.completed_at) {
        await replaceMessage(payload, ":warning: This review was already handled.");
        return res.status(200).end();
      }
      await approvePendingReview(pending, payload.user.id, payload.channel.id);
      await replaceMessage(payload, `:white_check_mark: *${pending.subtask_name}* approved by <@${payload.user.id}>.`);
      return res.status(200).end();
    }

    if (action.action_id === "review_comment") {
      const pending = await getPendingReviewById(action.value);
      if (!pending || pending.completed_at) {
        await replaceMessage(payload, ":warning: This review was already handled.");
        return res.status(200).end();
      }
      // trigger_id is only valid for ~3s — the single lookup above is the
      // only thing allowed to happen before this call.
      await openReviewCommentModal(payload.trigger_id, {
        pendingReviewId: pending.id,
        channelId: payload.channel.id,
        subtaskName: pending.subtask_name,
      });
      return res.status(200).end();
    }

    return res.status(200).end();
  } catch (err) {
    console.error("Interactivity handler error:", err);
    // Best-effort: tell the user something broke instead of silent failure
    try {
      await replaceMessage(payload, `:x: Something went wrong: ${err.message}`);
    } catch {}
    return res.status(200).end();
  }
}

/** Replace the original interactive message via its response_url (removes the buttons). */
async function replaceMessage(payload, text) {
  await fetch(payload.response_url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ replace_original: true, text }),
  });
}
