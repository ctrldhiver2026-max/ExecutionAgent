// Feeds the dashboard's "Upcoming" tab — scheduled meetings the calendar
// watcher has picked up (api/calendar/poll.js), so a calendar invite shows
// up in the app even before the meeting happens.
import { listCalendarNotifications } from "../../lib/db.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const events = await listCalendarNotifications(25);
    res.status(200).json({ events });
  } catch (err) {
    console.error("[calendar/upcoming] failed", err);
    res.status(500).json({ error: "Failed to load upcoming meetings" });
  }
}
