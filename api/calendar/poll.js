// Calendar watcher (pipeline step: manager schedules a call → Execution
// Agent reads the invite → soft notification). DMs each invitee directly —
// resolved from their real calendar email via the same zero-touch Slack
// lookup the rest of the pipeline uses (lib/roster.js) — no shared channel
// to create or invite the bot into. Triggered every ~5 minutes by GitHub
// Actions (.github/workflows/calendar-poll.yml); also callable manually.
import { listUpcomingEvents } from "../../lib/google.js";
import { postMessage, notifyUpcomingMeeting } from "../../lib/slack.js";
import { getOrCreateAttendeeIdentity } from "../../lib/roster.js";
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

function channelNotificationText(event) {
  const invitees = event.attendees.map((a) => a.name || a.email).join(", ") || "no invitees listed";
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

  // Optional bonus: also post a summary to a shared channel, if one's set up.
  // Not required — DMs to actual invitees (below) are the primary path.
  const bonusChannel = process.env.SLACK_NOTIFY_CHANNEL;

  try {
    const events = await listUpcomingEvents(LOOKAHEAD_MINUTES);
    const meetings = events.filter((e) => e.meetCode || e.meetLink);

    const alreadyNotified = await getNotifiedEventIds();
    const fresh = meetings.filter((e) => !alreadyNotified.has(e.id));

    let dmsSent = 0;
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
        const whenText = `${formatStart(event.start)} IST`;
        const attendeesWithEmail = (event.attendees || []).filter((a) => a.email);
        const identities = await Promise.all(
          attendeesWithEmail.map((a) => getOrCreateAttendeeIdentity({ email: a.email, name: a.name }))
        );
        const notifiable = identities.filter((p) => p.slack_id);

        for (const person of notifiable) {
          try {
            await notifyUpcomingMeeting(person.slack_id, { title: event.title, whenText });
            dmsSent += 1;
          } catch (err) {
            // One person's DM failing shouldn't sink the rest of the invitees.
            console.error(`[calendar/poll] DM failed for ${person.name} (non-fatal)`, err);
          }
        }
        if (notifiable.length === 0) {
          console.log(`[calendar/poll] no Slack-linked invitees found for "${event.title}" — nobody to DM`);
        }

        if (bonusChannel) {
          await postMessage(bonusChannel, channelNotificationText(event)).catch((err) =>
            console.error("[calendar/poll] bonus channel post failed (non-fatal)", err)
          );
        }
      } catch (err) {
        // Resolution itself broke (not just one person's DM) — roll the mark
        // back so the next poll retries this event properly.
        console.error(`[calendar/poll] notify failed for event ${event.id}`, err);
        await unmarkEventNotified(event.id).catch((rollbackErr) =>
          console.error(`[calendar/poll] rollback failed for event ${event.id}`, rollbackErr)
        );
      }
    }

    console.log(`[calendar/poll] upcoming=${meetings.length} fresh=${fresh.length} dmsSent=${dmsSent}`);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[calendar/poll] failed", err);
    res.status(500).json({ error: "Poll failed" });
  }
}
