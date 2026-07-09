// Timeline feed for the dashboard (public/index.html).
// Returns recent confirmation requests + provisioned projects so the UI can
// show each meeting's pipeline progress: captured → extracted → confirmed →
// channel/ClickUp created → team notified.
//
// Also carries two Project Status extras, folded in here rather than as
// their own files — Vercel Hobby caps a deployment at 12 serverless
// functions and this repo sits exactly at that cap (see api/health.js's
// git history for the same constraint hit twice before):
//   GET  ?live_status_for=<clickup_task_id>  -> on-track/assignees computed
//        live from ClickUp (never stored — always current).
//   POST { meeting_id, held_by_id }          -> set the project's manually-
//        picked owner/DRI (roster id, or null to unset).
import { listPendingConfirmations, listProjects, updateProjectHeldBy, listCompletedReviews } from "../../lib/db.js";
import { getProjectLiveStatus } from "../../lib/clickup.js";

export default async function handler(req, res) {
  // Public read-only data; CORS open so the dashboard also works when
  // opened as a local file or from an editor preview origin.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method === "POST") {
    const { meeting_id, held_by_id } = req.body || {};
    if (typeof meeting_id !== "string" || !meeting_id) {
      res.status(400).json({ error: "meeting_id (string) is required" });
      return;
    }
    try {
      const project = await updateProjectHeldBy(meeting_id, held_by_id ?? null);
      if (!project) {
        res.status(404).json({ error: "No project row for that meeting_id" });
        return;
      }
      res.status(200).json({ project });
    } catch (err) {
      console.error("[pipeline/status] held_by update failed", err);
      res.status(500).json({ error: "Failed to save" });
    }
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const liveStatusFor = req.query.live_status_for;
  if (typeof liveStatusFor === "string" && liveStatusFor) {
    try {
      const status = await getProjectLiveStatus(liveStatusFor);
      res.status(200).json(status);
    } catch (err) {
      console.error("[pipeline/status] live status fetch failed", err);
      res.status(500).json({ error: "Failed to load live status" });
    }
    return;
  }

  try {
    const [confirmations, projects, reviews] = await Promise.all([
      listPendingConfirmations(50),
      listProjects(50),
      listCompletedReviews(100),
    ]);
    res.status(200).json({ confirmations, projects, reviews });
  } catch (err) {
    // Full detail stays server-side — the rest() error text includes raw
    // PostgREST responses, which must not reach unauthenticated clients.
    console.error("[pipeline/status] failed", err);
    res.status(500).json({ error: "Failed to load pipeline status" });
  }
}
