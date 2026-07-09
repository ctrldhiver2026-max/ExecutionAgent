# Slack Bot & Orchestration — Hari's slice

Serverless handlers for pipeline stages **3 (Confirmation)**, **5 (Channel provisioning)**, **7 (Notifier)**, and the Slack half of **4 (manager-pick flow)**.

## File map

```
api/slack/confirm.js        POST entry: store pending confirmation + send Yes/No DM
api/slack/interactivity.js  Button clicks: confirm / reject / designer pick
api/slack/events.js         Events API URL verification (challenge echo)
lib/slack.js                Signature verification + all Slack API calls
lib/db.js                   Supabase REST helpers (pending_confirmations, projects)
lib/orchestrator.js         Post-confirmation flow: assignment → channel → ClickUp → notify
lib/roster.js                Role resolution + the 3-flow design assignment engine
lib/clickup.js               ClickUp parent task + per-deliverable subtasks
lib/google.js                Calendar OAuth + event lookup (watcher + organizer correlation)
```

## 1. Slack app config (api.slack.com/apps)

1. **OAuth & Permissions → Bot Token Scopes:** `channels:manage`, `chat:write`, `users:read`, plus `im:write` (needed for `conversations.open` to DM people) and `mpim:write` if you ever DM groups.
   - **`users:read.email` — required** for zero-touch attendee mapping (`lib/roster.js` / `users.lookupByEmail`): turns a calendar invite's email straight into a Slack ID with no manual entry anywhere. Without this scope, new attendees get discovered but never get invited to the channel or DMed — add the scope, then **Reinstall to Workspace** (required after any scope change) for it to take effect.
   - **`channels:history` — required (2026-07-10)** for the review-approval flow (`api/slack/events.js`): the bot needs to read messages posted in a project channel to detect "@approver here's the link" and prompt for approval. Without it, Slack simply never sends `message.channels` events to your Request URL.
2. **Interactivity & Shortcuts → ON**, Request URL:
   `https://execution-agent.vercel.app/api/slack/interactivity`
3. **Event Subscriptions → ON**, Request URL:
   `https://execution-agent.vercel.app/api/slack/events`
   — deploy first, Slack pings the URL with a challenge on save.
   Subscribe to bot event **`message.channels`** (required for the
   review-approval flow above — without this subscription, `channels:history`
   alone does nothing since Slack never pushes the events).
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

-- REQUIRED migration (2026-07-09): the roster is self-populating and can
-- discover someone by name only (e.g. a task owner mentioned in a meeting
-- who wasn't on the call, or an ad-hoc attendee matched via Slack) — those
-- rows have no email yet, so the original NOT NULL must be dropped. The
-- code degrades gracefully if this hasn't run, but the person won't be
-- saved for future meetings until it has.
alter table roster alter column email drop not null;

-- REQUIRED migration (2026-07-10): added "video_design" as a fourth team.
-- The app-level enum (lib/extraction.js, api/roster/update.js) accepts it
-- already, but roster.team has its own DB-level check constraint that
-- rejects it until this runs — People-tab role saves for Video Design
-- fail with a 23514 violation otherwise.
alter table roster drop constraint roster_team_check;
alter table roster add constraint roster_team_check
  check (team is null or team in ('content', 'design', 'dev', 'video_design'));

-- REQUIRED migration (2026-07-10): dashboard's Project Status panel — who
-- currently owns/drives a provisioned project, manually picked from the
-- roster and independent of deliverable owners. Nullable: unset until
-- someone picks it on the dashboard. On-track status is NOT stored here —
-- it's computed live from ClickUp on every view (see lib/clickup.js
-- getProjectLiveStatus), so there's no "done" concept to keep in sync.
alter table projects add column if not exists held_by_id text;
```

**Optional ingest lockdown:** `/api/meetings/ingest` is public. To require auth,
set `INGEST_SECRET=ctrld-hiver-2026-ingest` in Vercel env vars — the extension
already sends that value as `x-ingest-token` (see `extension/background.js`).

## Calendar watcher setup (pipeline step 2: invite → soft notification)

`api/calendar/poll.js` reads upcoming events on the shared Google Calendar and
DMs each invitee directly — resolved from their real calendar email via the
same zero-touch Slack lookup the rest of the pipeline uses (`lib/roster.js`),
no shared channel to create or invite the bot into. GitHub Actions triggers
it every ~5 min (`.github/workflows/calendar-poll.yml`; Vercel Hobby only
allows daily crons). All demo meetings must be scheduled from the shared
`ctrldhiver2026@gmail.com` account's calendar. Picked-up meetings also show
up on the dashboard's **Upcoming** tab before they happen.

**Google credentials (one-time, ~10 min):**
1. [Google Cloud Console](https://console.cloud.google.com) → new project → enable **Google Calendar API**
2. OAuth consent screen → External → add ctrldhiver2026@gmail.com as test user
3. Credentials → OAuth client ID → **Web application** → redirect URI `https://developers.google.com/oauthplayground`
4. [OAuth Playground](https://developers.google.com/oauthplayground) → gear icon → "Use your own OAuth credentials" → paste client id/secret → authorize scope `https://www.googleapis.com/auth/calendar.readonly` (as ctrldhiver2026) → exchange for **refresh token**
   - No `refresh_token` in the response? Google only issues it on the *first* authorization — keep the Playground's "Force prompt: consent" on, or revoke the app at myaccount.google.com/permissions and redo
5. **⚠️ Token expiry:** a consent screen in "Testing" status issues refresh tokens that **expire after 7 days**. Re-mint within 7 days of demo day, or flip publishing status to "In production" (stays unverified — warning on consent is fine — tokens stop expiring). An expired token logs a loud `invalid_grant` error in Vercel logs.
6. Fill the `GOOGLE_*` env vars (see `.env.example`) in Vercel and redeploy. `SLACK_NOTIFY_CHANNEL` is optional — only needed if you *also* want a summary posted to a shared channel; DMs to actual invitees work without it.
7. Run the `calendar_notifications` SQL above in Supabase.

**Test:** create a calendar event with a Meet link, invite people using their
real emails, then `curl -X POST https://execution-agent.vercel.app/api/calendar/poll`
— each invitee with a matching Slack account gets a DM; counts (`dmsSent`)
are in the Vercel function logs. The event also appears on the dashboard's
Upcoming tab.

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

Expected: DM arrives → click **Yes** → message updates → channel `#webinar-july-2026` is created, you're invited, real ClickUp parent task + subtasks are created (needs `CLICKUP_API_TOKEN`/`CLICKUP_LIST_ID` set), kickoff message posts with the ClickUp link.

## 4. End-to-end trigger

`api/meetings/ingest.js` calls this confirm flow automatically once a real
project is extracted from a captured meeting — no manual curl needed for a
live test. It resolves the meeting organizer (calendar event → roster email
match, or `MANAGER_SLACK_ID` as a fallback) and sends them the confirm DM.

`lib/roster.js` and `lib/clickup.js` are the real (non-stub) role-resolution
and ClickUp integrations — see their file-header comments for the exact
contract each function follows.

## 5. Review-approval flow (deliverable done → reviewer approves → ClickUp closes)

No slash command, no button to kick it off — an assignee just posts a plain
message in their project's channel mentioning whoever should review it, with
a link: `@mansoor here's the landing page, please review: <figma link>`.

`api/slack/events.js` watches every message in every tracked project channel
for that shape (a mention + a URL). If it finds one, it identifies the
sender's ClickUp assignment in that project (matched by email, same
zero-touch identity resolution the rest of the pipeline uses) and — only if
they have **exactly one** open subtask there — posts a Yes/No "Is this
final?" prompt aimed at the mentioned person. Ambiguous (2+ open subtasks)
or unresolvable senders are skipped entirely rather than guessed at.

`api/slack/interactivity.js` handles the buttons: **Yes** sets that subtask
to the list's closed status via `lib/clickup.js` `setTaskComplete` and edits
the prompt into a confirmation everyone in the channel sees (that channel
already has the whole team in it, so no separate notification step is
needed); **No** edits the prompt to say so and DMs the assignee — no ClickUp
status change. Only the person named in the original mention can click
either button; anyone else gets a private (ephemeral) "not for you" reply.

## Gotchas learned the hard way (read before demo day)

- Slack interactivity has a **3-second ack window** — the handler acks first, then works. If Vercel kills the function before the work finishes, move the work into a second internal fetch call.
- `conversations.invite` fails if the bot isn't in the channel — the bot is auto-added as creator, so this only bites if you switch to pre-existing channels.
- Channel names: lowercase, ≤80 chars, no spaces — the helper sanitizes and retries on `name_taken` (happens constantly when re-running demos).
- Signature verification needs the **raw body** — that's why `bodyParser: false` is set on both webhook endpoints. Don't remove it.
