// Entry point for the extension's meeting-end POST.
// Runs Claude extraction on the transcript, persists the meeting, and logs.
//
// Integration seam (see README.md "Integration seams"): Charan's roster/
// role-resolution step picks up `extracted` here, resolves owner_name /
// attendees against the roster table, then POSTs the resolved payload to
// Hari's /api/slack/confirm. Not wired yet — logging only for now.
import { extractProject } from "../../lib/extraction.js";
import { createMeetingRecord } from "../../lib/db.js";

// Caps keep an unauthenticated caller from feeding us megabytes of junk
// (each ingest triggers a paid Claude call). Generous for real meetings.
const MAX_TRANSCRIPT_LINES = 3000;
const MAX_LINE_CHARS = 4000;
const MAX_ATTENDEES = 100;

/** Persist the meeting; capture already succeeded, so a DB failure only logs. */
async function persistMeeting({ meeting_id, ended_at, attendees, transcript, extracted }) {
  try {
    await createMeetingRecord({ meeting_id, ended_at, attendees, transcript, extracted });
  } catch (err) {
    console.error("[meetings/ingest] persistence failed", err);
  }
}

/** Returns a normalized payload, or null if the body is malformed. */
function validatePayload(body) {
  if (!body || typeof body !== "object") return null;
  const { meeting_id, transcript, attendees, ended_at } = body;

  if (meeting_id != null && typeof meeting_id !== "string") return null;
  if (ended_at != null && typeof ended_at !== "string") return null;

  const rawTranscript = transcript == null ? [] : transcript;
  const rawAttendees = attendees == null ? [] : attendees;
  if (!Array.isArray(rawTranscript) || !Array.isArray(rawAttendees)) return null;
  if (rawTranscript.length > MAX_TRANSCRIPT_LINES) return null;
  if (rawAttendees.length > MAX_ATTENDEES) return null;

  const cleanTranscript = [];
  for (const line of rawTranscript) {
    if (!line || typeof line !== "object") return null;
    if (typeof line.text !== "string" || line.text.length > MAX_LINE_CHARS) return null;
    if (typeof line.speaker !== "string") return null;
    cleanTranscript.push({
      speaker: line.speaker,
      text: line.text,
      ts: typeof line.ts === "string" ? line.ts : null,
    });
  }

  const cleanAttendees = [];
  for (const name of rawAttendees) {
    if (typeof name !== "string" || name.length > 500) return null;
    cleanAttendees.push(name);
  }

  return {
    meeting_id: meeting_id ?? null,
    ended_at: ended_at ?? null,
    transcript: cleanTranscript,
    attendees: cleanAttendees,
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Optional shared-secret gate: enforced only once INGEST_SECRET is set in
  // Vercel env vars (the extension sends x-ingest-token; see background.js).
  const secret = process.env.INGEST_SECRET;
  if (secret && req.headers["x-ingest-token"] !== secret) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const payload = validatePayload(req.body);
  if (!payload) {
    res.status(400).json({ error: "Invalid payload" });
    return;
  }
  const { meeting_id, transcript, attendees, ended_at } = payload;

  console.log("[meetings/ingest]", {
    meeting_id,
    ended_at,
    attendeeCount: attendees.length,
    transcriptLines: transcript.length,
  });

  try {
    const extracted = await extractProject({ transcript, attendees });
    console.log("[meetings/ingest] extracted", extracted);
    await persistMeeting({ meeting_id, ended_at, attendees, transcript, extracted });
    res.status(200).json({ status: "received", extracted });
  } catch (err) {
    // Capture already succeeded — an extraction failure shouldn't make the
    // extension think the POST failed. Detail stays in server logs only;
    // echoing err to unauthenticated callers would leak API internals.
    console.error("[meetings/ingest] extraction failed", err);
    await persistMeeting({ meeting_id, ended_at, attendees, transcript, extracted: null });
    res.status(200).json({ status: "received", extraction: "failed" });
  }
}
