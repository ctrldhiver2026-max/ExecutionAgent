// api/slack/interactivity.js
// Slack Interactivity Request URL → https://execution-agent.vercel.app/api/slack/interactivity
// Slack sends button clicks here as application/x-www-form-urlencoded with a `payload` field.

import { verifySlackSignature, slackApi } from "../../lib/slack.js";
import { getPendingConfirmation, updateConfirmationStatus } from "../../lib/db.js";
import { runProjectCreation } from "../../lib/orchestrator.js";

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

  // ── ACK FAST ─────────────────────────────────────────────────────────
  // Slack requires a response within 3s. Respond immediately, then do the
  // heavy work (channel creation, ClickUp) after. On Vercel the function
  // stays alive until the promise chain settles, but keep work short —
  // hackathon-fine, production would use a queue.
  res.status(200).end();

  try {
    if (action.action_id === "confirm_project") {
      const confirmation = await getPendingConfirmation(action.value);
      if (!confirmation || confirmation.status !== "pending") {
        await replaceMessage(payload, ":warning: This confirmation was already handled.");
        return;
      }
      await updateConfirmationStatus(action.value, "confirmed");
      await replaceMessage(payload, `:white_check_mark: Confirmed! Setting up *${confirmation.payload.project_name}*…`);

      // Hand off to the pipeline: assignment → channel → ClickUp → notify
      await runProjectCreation(confirmation);
      return;
    }

    if (action.action_id === "reject_project") {
      await updateConfirmationStatus(action.value, "rejected");
      await replaceMessage(payload, ":no_entry_sign: Got it — ignoring this one.");
      return;
    }

    if (action.action_id.startsWith("pick_designer_")) {
      const [confirmationId, designerSlackId] = action.value.split("|");
      const confirmation = await getPendingConfirmation(confirmationId);
      if (!confirmation) return;

      await replaceMessage(payload, `:art: Designer picked: <@${designerSlackId}>. Continuing setup…`);

      // Resume the pipeline with the chosen designer
      await runProjectCreation(confirmation, { designerSlackId });
      return;
    }
  } catch (err) {
    console.error("Interactivity handler error:", err);
    // Best-effort: tell the user something broke instead of silent failure
    try {
      await replaceMessage(payload, `:x: Something went wrong: ${err.message}`);
    } catch {}
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
