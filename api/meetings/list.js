// Meetings feed for the dashboard (public/index.html).
// Returns the 25 most recent captured meetings, newest first, per the
// contract in CLAUDE.md — `extracted` is null when extraction failed.
import { listMeetings } from "../../lib/db.js";

export default async function handler(req, res) {
  // Public read-only data; CORS open so the dashboard also works when
  // opened as a local file or from an editor preview origin.
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const meetings = await listMeetings(25);
    res.status(200).json({ meetings });
  } catch (err) {
    // Full detail stays server-side — the rest() error text includes raw
    // PostgREST responses, which must not reach unauthenticated clients.
    console.error("[meetings/list] failed", err);
    res.status(500).json({ error: "Failed to load meetings" });
  }
}
