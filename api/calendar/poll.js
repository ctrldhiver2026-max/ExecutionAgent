// Calendar watcher (pipeline step: manager schedules a call → Execution
// Agent reads the invite → soft notification in Slack).
// Reads upcoming events on the shared Google Calendar and sends a one-time
// notification for each newly scheduled meeting that has a Meet link.
// Triggered every ~5 minutes by GitHub Actions (.github/workflows/
// calendar-poll.yml); also callable manually for testing.
import { listUpcomingEvents } from "../../lib/google.js";
import { postMessage } from "../../lib/slack.js";
import { getNotifiedEventIds, markEventNotified, unmarkEventNotified } from "../../lib/db.js";

const LOOKAHEAD_MINUTES = 24 * 60;

function formatStart(iso) {
  if (!iso) return "time unknown";
  try {
    return new Intl.DateTimeFormat("en-IN", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Kolkata",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function notificationText(event) {
  const invitees =
    event.attendees.map((a) => a.name || a.email).join(", ") || "no invitees listed";
  return [
    `📅 *New meeting scheduled:* ${event.title}`,
    `*When:* ${formatStart(event.start)} IST`,
    `*Invitees:* ${invitees}`,
    `_Execution Agent will capture this call and turn it into tickets automatically._`,
  ].join("\n");
}

export default async function handler(req, res) {
  // Optional shared-secret gate, same pattern as /api/meetings/ingest —
  // enforced only once POLL_SECRET is set in Vercel env vars.
  const secret = process.env.POLL_SECRET;
  if (secret && req.headers["x-poll-token"] !== secret) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Graceful pre-setup: until the Google creds are configured, report ok so
  // the 5-minute GitHub cron stays green instead of spamming failure emails.
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REFRESH_TOKEN) {
    console.log("[calendar/poll] Google credentials not configured — skipping (see README 'Calendar watcher setup')");
    res.status(200).json({ ok: true });
    return;
  }

  const channel = process.env.SLACK_NOTIFY_CHANNEL;

  try {
    const events = await listUpcomingEvents(LOOKAHEAD_MINUTES);
    const meetings = events.filter((e) => e.meetCode || e.meetLink);

    if (!channel) {
      // Don't mark anything notified before notifications can actually go
      // out — once the channel is configured, the backlog gets announced.
      console.log(
        `[calendar/poll] SLACK_NOTIFY_CHANNEL not set — found ${meetings.length} upcoming meeting(s), notifying nothing`
      );
      res.status(200).json({ ok: true });
      return;
    }

    const alreadyNotified = await getNotifiedEventIds();
    const fresh = meetings.filter((e) => !alreadyNotified.has(e.id));

    let sent = 0;
    for (const event of fresh) {
      // Mark first: event_id is the primary key, so if two polls race the
      // second insert throws here and we never double-notify.
      try {
        await markEventNotified(event.id, event.title, event.start);
      } catch (err) {
        console.error(`[calendar/poll] dedup mark failed for event ${event.id} (likely a concurrent poll)`, err);
        continue;
      }
      try {
        await postMessage(channel, notificationText(event));
        sent += 1;
      } catch (err) {
        // Slack failed (wrong channel id, bot not invited, outage) — roll the
        // mark back so the next poll retries instead of losing the event forever.
        console.error(`[calendar/poll] Slack notify failed for event ${event.id}`, err);
        await unmarkEventNotified(event.id).catch((rollbackErr) =>
          console.error(`[calendar/poll] rollback failed for event ${event.id}`, rollbackErr)
        );
      }
    }

    console.log(`[calendar/poll] upcoming=${meetings.length} fresh=${fresh.length} sent=${sent}`);
    // Counts stay in the server log — no need to disclose meeting metadata
    // to unauthenticated callers.
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[calendar/poll] failed", err);
    res.status(500).json({ error: "Poll failed" });
  }
}
