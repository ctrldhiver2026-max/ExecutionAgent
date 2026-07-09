# Slack Bot & Orchestration — Hari's slice

Serverless handlers for pipeline stages **3 (Confirmation)**, **5 (Channel provisioning)**, **7 (Notifier)**, and the Slack half of **4 (manager-pick flow)**.

## File map

```
api/slack/confirm.js        POST entry: store pending confirmation + send Yes/No DM
api/slack/interactivity.js  Button clicks: confirm / reject / designer pick
api/slack/events.js         Events API URL verification (challenge echo)
lib/slack.js                Signature verification + all Slack API calls
lib/db.js                   Supabase REST helpers (pending_confirmations, projects)
lib/orchestrator.js         Post-confirmation flow; Charan's stubs clearly marked
```

## 1. Slack app config (api.slack.com/apps)

1. **OAuth & Permissions → Bot Token Scopes:** `channels:manage`, `chat:write`, `users:read`, plus `im:write` (needed for `conversations.open` to DM people) and `mpim:write` if you ever DM groups.
2. **Interactivity & Shortcuts → ON**, Request URL:
   `https://execution-agent.vercel.app/api/slack/interactivity`
3. **Event Subscriptions → ON** (optional for now), Request URL:
   `https://execution-agent.vercel.app/api/slack/events`
   — deploy first, Slack pings the URL with a challenge on save.
4. **Install App to Workspace** → copy the Bot User OAuth Token (`xoxb-…`).
5. **Basic Information → Signing Secret** → copy.
6. Add both to `.env` locally and Vercel → Settings → Environment Variables.

## 2. Supabase tables (run in SQL editor)

```sql
create table pending_confirmations (
  id uuid primary key default gen_random_uuid(),
  meeting_id text,
  project_name text not null,
  extracted_json jsonb not null,
  status text not null default 'pending', -- pending | confirmed | rejected
  slack_thread_ts text,
  created_at timestamptz default now()
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  meeting_id text,
  project_name text,
  clickup_task_id text,
  clickup_url text,
  slack_channel_id text,
  created_at timestamptz default now()
);

-- Captured meetings (Mansoor's slice): raw transcript + attendees + Claude
-- extraction output, displayed on the dashboard at the deployment root URL.
create table meetings (
  id uuid primary key default gen_random_uuid(),
  meeting_id text,
  ended_at timestamptz,
  attendees jsonb not null default '[]',
  transcript jsonb not null default '[]',
  extracted jsonb,
  created_at timestamptz default now()
);

-- Calendar watcher dedup: one row per calendar event we've announced, so a
-- meeting is never notified twice (event_id PK doubles as the race guard).
create table calendar_notifications (
  event_id text primary key,
  title text,
  start_at timestamptz,
  notified_at timestamptz default now()
);
```

**Optional ingest lockdown:** `/api/meetings/ingest` is public. To require auth,
set `INGEST_SECRET=ctrld-hiver-2026-ingest` in Vercel env vars — the extension
already sends that value as `x-ingest-token` (see `extension/background.js`).

## Calendar watcher setup (pipeline step 2: invite → soft notification)

`api/calendar/poll.js` reads upcoming events on the shared Google Calendar and
posts a one-time Slack notification per newly scheduled Meet-linked meeting.
GitHub Actions triggers it every ~5 min (`.github/workflows/calendar-poll.yml`;
Vercel Hobby only allows daily crons). All demo meetings must be scheduled
from the shared `ctrldhiver2026@gmail.com` account's calendar.

**Google credentials (one-time, ~10 min):**
1. [Google Cloud Console](https://console.cloud.google.com) → new project → enable **Google Calendar API**
2. OAuth consent screen → External → add ctrldhiver2026@gmail.com as test user
3. Credentials → OAuth client ID → **Web application** → redirect URI `https://developers.google.com/oauthplayground`
4. [OAuth Playground](https://developers.google.com/oauthplayground) → gear icon → "Use your own OAuth credentials" → paste client id/secret → authorize scope `https://www.googleapis.com/auth/calendar.readonly` (as ctrldhiver2026) → exchange for **refresh token**
   - No `refresh_token` in the response? Google only issues it on the *first* authorization — keep the Playground's "Force prompt: consent" on, or revoke the app at myaccount.google.com/permissions and redo
5. **⚠️ Token expiry:** a consent screen in "Testing" status issues refresh tokens that **expire after 7 days**. Re-mint within 7 days of demo day, or flip publishing status to "In production" (stays unverified — warning on consent is fine — tokens stop expiring). An expired token logs a loud `invalid_grant` error in Vercel logs.
6. Fill the `GOOGLE_*` + `SLACK_NOTIFY_CHANNEL` env vars (see `.env.example`) in Vercel and redeploy. `SLACK_NOTIFY_CHANNEL` is the channel ID (channel details → bottom) of e.g. `#execution-agent-feed` — invite the bot to that channel.
7. Run the `calendar_notifications` SQL above in Supabase.

**Test:** create a calendar event with a Meet link for later today, then
`curl -X POST https://execution-agent.vercel.app/api/calendar/poll` — the
Slack message lands in the channel; counts (`upcoming/fresh/sent`) are in the
Vercel function logs.

**Optional lockdown:** set `POLL_SECRET` in Vercel **and** the identical value
as a GitHub Actions secret named `POLL_SECRET` — strictly both-or-neither.
Only Vercel set → every cron run 401s (workflow shows red ✗ every 5 min).
Only GitHub set → the endpoint silently stays open while the workflow looks
locked down.

## 3. Solo test (Phase 1–2, no extension/extraction needed)

Deploy, then fire a fake project at the confirm endpoint — replace `U0YOURID` with **your own** Slack member ID so the DM lands with you:

```bash
curl -X POST https://execution-agent.vercel.app/api/slack/confirm \
  -H "Content-Type: application/json" \
  -d '{
    "initiator_slack_id": "U0A73V3SZ9N",
    "project": {
      "meeting_id": "test-001",
      "project_name": "Webinar July 2026",
      "deliverables": [
        {"team": "content", "task": "Landing page copy", "owner_name": "Asha"},
        {"team": "design", "task": "Webinar banner", "owner_name": "Ravi"},
        {"team": "dev", "task": "Registration page", "owner_name": "Kiran"}
      ],
      "attendees": [
        {"name": "Asha", "slack_id": "U0YOURID", "team": "content"}
      ]
    }
  }'
```

Expected: DM arrives → click **Yes** → message updates → channel `#webinar-july-2026` is created, you're invited, kickoff message posts with stub ClickUp link.

## 4. Integration seams (Phase 3)

- **Mansoor → you:** his pipeline calls `POST /api/slack/confirm` with the extracted project JSON.
- **Charan → you:** he replaces `resolveAssignments()` and `createClickUpTickets()` in `lib/orchestrator.js` — signatures are documented in the stubs, don't change them without telling him.

## Gotchas learned the hard way (read before demo day)

- Slack interactivity has a **3-second ack window** — the handler acks first, then works. If Vercel kills the function before the work finishes, move the work into a second internal fetch call.
- `conversations.invite` fails if the bot isn't in the channel — the bot is auto-added as creator, so this only bites if you switch to pre-existing channels.
- Channel names: lowercase, ≤80 chars, no spaces — the helper sanitizes and retries on `name_taken` (happens constantly when re-running demos).
- Signature verification needs the **raw body** — that's why `bodyParser: false` is set on both webhook endpoints. Don't remove it.
