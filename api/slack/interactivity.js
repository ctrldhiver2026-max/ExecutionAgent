// api/slack/interactivity.js
// Slack Interactivity Request URL → https://execution-agent.vercel.app/api/slack/interactivity
// Slack sends button clicks here as application/x-www-form-urlencoded with a `payload` field.

import { verifySlackSignature, slackApi, postMessage, openDm } from "../../lib/slack.js";
import { getPendingConfirmation, updateConfirmationStatus } from "../../lib/db.js";
import { runProjectCreation } from "../../lib/orchestrator.js";
import { setTaskComplete } from "../../lib/clickup.js";

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

  const action = payload.actions?.[0];
  if (!action) return res.status(200).end();

  // Slack retries the same interaction if it doesn't get a response in
  // time (marked with this header). Since we now await the full flow
  // before responding, a slow-but-still-in-progress first attempt could
  // get retried — ack without reprocessing so we don't double-create the
  // channel/ticket/DB row.
  if (req.headers["x-slack-retry-num"]) {
    return res.status(200).end();
  }

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

      // Hand off to the pipeline: assignment → channel → ClickUp → notify
      await runProjectCreation(confirmation);
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

    if (action.action_id === "approve_deliverable" || action.action_id === "reject_deliverable") {
      const [subtaskId, assigneeSlackId, approverSlackId, taskName] = action.value.split("|");
      const clicker = payload.user?.id;

      // Anyone in the channel can see the buttons, but only the person
      // named in the review request should be able to answer it — silent
      // to everyone else (ephemeral, so it doesn't clutter the channel).
      if (clicker !== approverSlackId) {
        await postEphemeral(payload, `Only <@${approverSlackId}> can respond to this review request.`);
        return res.status(200).end();
      }

      if (action.action_id === "approve_deliverable") {
        await setTaskComplete(subtaskId);
        await replaceMessage(payload, `:white_check_mark: *${taskName}* approved by <@${clicker}> — marked complete.`);
      } else {
        await replaceMessage(payload, `:x: *${taskName}* not approved yet by <@${clicker}>.`);
        // No ClickUp status change — just let the assignee know so they can follow up.
        try {
          const dm = await openDm(assigneeSlackId);
          await postMessage(dm, `Your update on "${taskName}" wasn't approved yet by <@${approverSlackId}> — check the channel for context.`);
        } catch (err) {
          console.error("[interactivity] rejection DM to assignee failed (non-fatal)", err);
        }
      }
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

/** Reply visible only to the clicker — used to rebuff someone who isn't the named approver, without cluttering the channel for everyone else. */
async function postEphemeral(payload, text) {
  await fetch(payload.response_url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }),
  });
}
