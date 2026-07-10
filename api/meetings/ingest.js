// Entry point for the extension's meeting-end POST.
// Runs Claude extraction on the transcript, persists the meeting, resolves
// attendees + the meeting organizer via the calendar invite (real emails,
// zero manual roster entry — see lib/roster.js), and DMs the organizer to
// confirm the project before the rest of the pipeline (Slack channel +
// ClickUp tickets) runs.
import { extractProject } from "../../lib/extraction.js";
import {
  createMeetingRecord,
  createPendingConfirmation,
  getRecentMeetingByMeetingId,
  updateMeetingRecord,
} from "../../lib/db.js";
import { resolveAttendees, getOrCreateAttendeeIdentity, inferMissingTeams } from "../../lib/roster.js";
import { findEventByMeetCode } from "../../lib/google.js";
import { sendConfirmationDm } from "../../lib/slack.js";

// Caps keep an unauthenticated caller from feeding us megabytes of junk
// (each ingest triggers a paid Claude call). Generous for real meetings.
const MAX_TRANSCRIPT_LINES = 3000;
const MAX_LINE_CHARS = 4000;
const MAX_ATTENDEES = 100;

/**
 * Persist the meeting; capture already succeeded, so a DB failure only logs.
 * updateId set means this is a merge into an existing row (see the
 * duplicate-capture dedup in the handler below) — UPDATE instead of INSERT
 * so it doesn't show up as a second card on the dashboard.
 */
async function persistMeeting({ meeting_id, ended_at, attendees, transcript, extracted, updateId }) {
  try {
    if (updateId) {
      await updateMeetingRecord(updateId, { ended_at, attendees, transcript, extracted });
    } else {
      await createMeetingRecord({ meeting_id, ended_at, attendees, transcript, extracted });
    }
  } catch (err) {
    console.error("[meetings/ingest] persistence failed", err);
  }
}

/**
 * Pipeline step 4: DM the meeting organizer "still ON?" with confirm buttons.
 * The organizer is found via the calendar event matching this meeting's Meet
 * code (event.organizer email → roster → slack_id); MANAGER_SLACK_ID is a
 * fallback for when the calendar isn't configured yet or no match is found.
 * Entirely non-fatal — capture + extraction already succeeded by this point.
 */
async function triggerConfirmation({ meeting_id, extracted, attendees }) {
  if (!extracted?.project_name) {
    console.log("[meetings/ingest] no concrete project extracted — skipping confirmation trigger");
    return;
  }

  let initiatorSlackId = null;
  let calendarEvent = null;
  try {
    calendarEvent = await findEventByMeetCode(meeting_id);
    if (calendarEvent?.organizer) {
      const organizer = await getOrCreateAttendeeIdentity({
        email: calendarEvent.organizer,
        name: null,
        });
        initiatorSlackId = organizer?.slack_id || null;
        if (!initiatorSlackId) {
        console.log(`[meetings/ingest] calendar organizer ${calendarEvent.organizer} could not be resolved to Slack`);
      }
    } else {
      console.log(`[meetings/ingest] no calendar event found for meet code ${meeting_id}`);
    }
  } catch (err) {
    console.error("[meetings/ingest] calendar lookup failed (non-fatal)", err);
  }

  if (!initiatorSlackId) initiatorSlackId = process.env.MANAGER_SLACK_ID || null;
  if (!initiatorSlackId) {
    console.log("[meetings/ingest] no initiator resolved (no calendar match, no MANAGER_SLACK_ID) — skipping confirmation DM");
    return;
  }

  try {
    // "Who attended" always comes from the extension's capture (attendees);
    // the calendar invite only supplies a real email for each captured name
    // — zero-touch, auto-creates a roster row via Slack email lookup for
    // anyone not seen before. Falls back to name-only roster matching when
    // no calendar email is found for a captured attendee.
    const resolvedAttendees = await resolveAttendees(attendees, calendarEvent?.attendees || []);
    // Best-effort role inference: someone with no team yet who's named as a
    // deliverable owner gets tagged with that deliverable's team, so the
    // 3-flow assignment engine can consider them for THIS meeting too.
    await inferMissingTeams(resolvedAttendees, extracted.deliverables);
    const project = {
      meeting_id,
      project_name: extracted.project_name,
      deliverables: extracted.deliverables || [],
      due_dates: extracted.due_dates,
      project_due_date: extracted.project_due_date,
      attendees: resolvedAttendees,
      // extraction's summary (the MOM) -- postProjectKickoff reads this off
      // confirmation.payload.summary; it was extracted but never made it
      // into the stored payload, so the kickoff message's summary block
      // silently had nothing to show (live incident 2026-07-10).
      summary: extracted.summary,
    };
    const confirmation = await createPendingConfirmation(project);
    await sendConfirmationDm(initiatorSlackId, project.project_name, confirmation.id);
    console.log(`[meetings/ingest] confirmation DM sent to ${initiatorSlackId} for "${project.project_name}"`);
  } catch (err) {
    console.error("[meetings/ingest] confirmation trigger failed (non-fatal)", err);
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
  let { meeting_id, transcript, attendees, ended_at } = payload;

  console.log("[meetings/ingest]", {
    meeting_id,
    ended_at,
    attendeeCount: attendees.length,
    transcriptLines: transcript.length,
  });

  // Duplicate-capture guard (live incident 2026-07-10: a page reload / tab-
  // close race posted the SAME real-world call twice, ~5s apart, with
  // different partial attendee lists — two separate dashboard cards for one
  // meeting, plus a wasted Claude call on the incomplete one). If a row for
  // this exact meeting_id was created recently, merge into it (UPDATE, not
  // INSERT) instead of creating a visible duplicate.
  const existing = await getRecentMeetingByMeetingId(meeting_id).catch((err) => {
    console.error("[meetings/ingest] duplicate-capture lookup failed (non-fatal, proceeding as new)", err);
    return null;
  });
  const updateId = existing?.id;
  if (existing) {
    transcript = transcript.length > (existing.transcript?.length || 0) ? transcript : existing.transcript;
    attendees = Array.from(new Set([...(existing.attendees || []), ...attendees]));
    if (existing.extracted?.project_name) {
      // Already extracted a real project from this meeting — just top up
      // the record with anything new, don't re-run the paid extraction or
      // risk a second confirmation DM for the same project.
      await persistMeeting({ meeting_id, ended_at, attendees, transcript, extracted: existing.extracted, updateId });
      console.log(`[meetings/ingest] merged duplicate capture into existing meeting ${updateId} — skipping re-extraction`);
      res.status(200).json({ status: "received", extraction: "skipped_duplicate_already_processed" });
      return;
    }
  }

  // Nothing to extract from an empty transcript (CC never enabled, or an
  // empty probe) — persist the record as a capture-failure signal, but don't
  // spend a Claude call on it.
  if (transcript.length === 0) {
    await persistMeeting({ meeting_id, ended_at, attendees, transcript, extracted: null, updateId });
    res.status(200).json({ status: "received", extraction: "skipped_empty_transcript" });
    return;
  }

  try {
    const extracted = await extractProject({ transcript, attendees });
    console.log("[meetings/ingest] extracted", extracted);
    await persistMeeting({ meeting_id, ended_at, attendees, transcript, extracted, updateId });
    await triggerConfirmation({ meeting_id, extracted, attendees });
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
