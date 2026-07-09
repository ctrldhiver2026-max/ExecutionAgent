// api/slack/confirm.js
// Pipeline stage 3 entry point. api/meetings/ingest.js calls this
// automatically after extraction + roster resolution for every real
// meeting; this HTTP endpoint exists for manual/solo testing (see below).
// Stores the project as a pending confirmation, then DMs the meeting
// initiator with Yes/No buttons.
//
// POST https://execution-agent.vercel.app/api/slack/confirm
// Body: {
//   initiator_slack_id: "U0XXXXXXX",
//   project: { meeting_id, project_name, deliverables, due_dates, attendees }
// }
//
// SOLO TESTING (Phase 1/2, before integration): curl this endpoint directly
// with a fake project — see README.md for a ready-made curl command.

import { sendConfirmationDm } from "../../lib/slack.js";
import { createPendingConfirmation } from "../../lib/db.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const { initiator_slack_id, project } = req.body || {};
    if (!initiator_slack_id || !project?.project_name) {
      return res.status(400).json({ error: "initiator_slack_id and project.project_name required" });
    }

    const confirmation = await createPendingConfirmation(project);
    await sendConfirmationDm(initiator_slack_id, project.project_name, confirmation.id);

    return res.status(200).json({ ok: true, confirmation_id: confirmation.id });
  } catch (err) {
    console.error("confirm endpoint error:", err);
    return res.status(500).json({ error: err.message });
  }
}
