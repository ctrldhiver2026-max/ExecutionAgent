// Workflow-timeline feed for the dashboard (public/index.html).
// Returns recent confirmation requests + provisioned projects so the UI can
// show each meeting's pipeline progress: captured → extracted → confirmed →
// channel/ClickUp created → team notified.
import { listPendingConfirmations, listProjects } from "../../lib/db.js";

export default async function handler(req, res) {
  // Public read-only data; CORS open so the dashboard also works when
  // opened as a local file or from an editor preview origin.
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const [confirmations, projects] = await Promise.all([
      listPendingConfirmations(50),
      listProjects(50),
    ]);
    res.status(200).json({ confirmations, projects });
  } catch (err) {
    // Full detail stays server-side — the rest() error text includes raw
    // PostgREST responses, which must not reach unauthenticated clients.
    console.error("[pipeline/status] failed", err);
    res.status(500).json({ error: "Failed to load pipeline status" });
  }
}
