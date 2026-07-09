// Dashboard's delete controls: per-card trash icon and "Clear all" button.
// Deleting a meeting cascades to its project + confirmation records (same
// logical unit from the user's perspective); { all: true } wipes everything
// in all three tables. Roster (real people) is never touched here.
import {
  deleteMeeting,
  deleteProjectsByMeetingId,
  deletePendingConfirmationsByMeetingId,
  deleteAllMeetingsData,
} from "../../lib/db.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { id, meeting_id, all } = req.body || {};

  try {
    if (all === true) {
      await deleteAllMeetingsData();
      res.status(200).json({ ok: true });
      return;
    }

    if (typeof id !== "string" || !id) {
      res.status(400).json({ error: "id (string) is required unless all:true" });
      return;
    }

    await deleteMeeting(id);
    if (typeof meeting_id === "string" && meeting_id) {
      await deleteProjectsByMeetingId(meeting_id).catch((err) =>
        console.error("[meetings/delete] projects cascade failed (non-fatal)", err)
      );
      await deletePendingConfirmationsByMeetingId(meeting_id).catch((err) =>
        console.error("[meetings/delete] confirmations cascade failed (non-fatal)", err)
      );
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[meetings/delete] failed", err);
    res.status(500).json({ error: "Failed to delete" });
  }
}
