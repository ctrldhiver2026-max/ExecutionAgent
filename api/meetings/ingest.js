// Entry point for the extension's meeting-end POST.
// Runs Claude extraction on the transcript and logs the structured result.
//
// Integration seam (see README.md "Integration seams"): Charan's roster/
// role-resolution step picks up `extracted` here, resolves owner_name /
// attendees against the roster table, then POSTs the resolved payload to
// Hari's /api/slack/confirm. Not wired yet — logging only for now.
import { extractProject } from "../../lib/extraction.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { meeting_id, transcript = [], attendees = [], ended_at } = req.body || {};
  console.log("[meetings/ingest]", {
    meeting_id,
    ended_at,
    attendeeCount: attendees.length,
    transcriptLines: transcript.length,
  });

  try {
    const extracted = await extractProject({ transcript, attendees });
    console.log("[meetings/ingest] extracted", extracted);
    res.status(200).json({ status: "received", extracted });
  } catch (err) {
    // Capture already succeeded — an extraction failure shouldn't make the
    // extension think the POST failed, just log it for debugging.
    console.error("[meetings/ingest] extraction failed", err);
    res.status(200).json({ status: "received", extraction_error: String(err) });
  }
}
