// Dashboard's per-card kebab menu: delete and rename. Deleting a meeting
// cascades to its project + confirmation records (same logical unit from
// the user's perspective); { all: true } wipes everything in all three
// tables. Roster (real people) is never touched here.
import {
  deleteMeeting,
  deleteProjectsByMeetingId,
  deletePendingConfirmationsByMeetingId,
  deleteAllMeetingsData,
  getMeetingById,
  updateMeetingExtracted,
  updateProjectNameByMeetingId,
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

  const { id, meeting_id, all, action, project_name } = req.body || {};

  try {
    if (action === "rename") {
      if (typeof id !== "string" || !id || typeof project_name !== "string" || !project_name.trim()) {
        res.status(400).json({ error: "id (string) and project_name (non-empty string) are required to rename" });
        return;
      }
      const meeting = await getMeetingById(id);
      if (!meeting) {
        res.status(404).json({ error: "No meeting row with that id" });
        return;
      }
      const extracted = (meeting.extracted && typeof meeting.extracted === "object") ? meeting.extracted : {};
      const updated = await updateMeetingExtracted(id, { ...extracted, project_name: project_name.trim() });
      // Cosmetic cascade only — does not rename the actual ClickUp task or
      // Slack channel, just keeps the dashboard's own project list in sync.
      if (typeof meeting_id === "string" && meeting_id) {
        await updateProjectNameByMeetingId(meeting_id, project_name.trim()).catch((err) =>
          console.error("[meetings/delete] project_name cascade failed (non-fatal)", err)
        );
      }
      res.status(200).json({ ok: true, meeting: updated });
      return;
    }

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
