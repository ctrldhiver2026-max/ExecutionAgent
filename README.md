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
  payload jsonb not null,
  status text not null default 'pending', -- pending | confirmed | rejected
  created_at timestamptz default now()
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  meeting_id text,
  project_name text,
  clickup_task_id text,
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
```

**Optional ingest lockdown:** `/api/meetings/ingest` is public. To require auth,
set `INGEST_SECRET=ctrld-hiver-2026-ingest` in Vercel env vars — the extension
already sends that value as `x-ingest-token` (see `extension/background.js`).

## 3. Solo test (Phase 1–2, no extension/extraction needed)

Deploy, then fire a fake project at the confirm endpoint — replace `U0YOURID` with **your own** Slack member ID so the DM lands with you:

```bash
curl -X POST https://execution-agent.vercel.app/api/slack/confirm \
  -H "Content-Type: application/json" \
  -d '{
    "initiator_slack_id": "U0YOURID",
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
