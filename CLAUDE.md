# Execution Agent — Architecture & Execution Plan (v3)
Team Ctrl+D's | 3 people — Mansoor, Hari, Charan

---

## 1. Start Here — For Teammates Opening This Project

If you're Hari, Charan, or Mansoor: open Claude Code in this project folder and tell it your name — e.g. *"I'm Hari, what should I work on?"* Claude will read your section under **Section 6 (Work Split)** and walk you through your role, your setup checklist, and what to build first, phase by phase.

---

## 2. Shared Environment Setup — Connect These First

Yes — connect GitHub, Vercel, Supabase, and ClickUp **before** splitting into individual work, as a ~20–30 minute step done together. If each person spins up their own fork, deployment, or database, nobody's code or data lines up when you try to run the full pipeline together later.

**Order to set up:**
1. **GitHub** — create ONE shared repo (e.g. `execution-agent`). All 3 people clone it. Single source of truth for code.
2. **Vercel** — link it to that GitHub repo. Every push to `main` auto-deploys to one shared public URL. This URL becomes:
   - The webhook endpoint Slack's Events API + Interactivity posts to
   - The endpoint the Chrome extension's background worker POSTs the transcript to
   - The endpoint ClickUp calls if you wire status-change webhooks
   - Replaces ngrok for the demo — a real deployed URL is more reliable on stage than a tunnel
3. **Supabase** — create ONE shared project. This is your state store:
   - `roster` table — the 10–15 person mock roster
   - `pending_confirmations` — extracted-but-not-yet-approved projects
   - `projects` — mapping meeting → ClickUp ticket → Slack channel (needed for the notifier/closure step)
   - Share the project URL + anon/service key via Vercel's environment variables — **never commit these to the repo**
4. **ClickUp** — create one List for the hackathon (e.g. "Execution Agent Demo"), grab an API token, add it to Vercel's environment variables.

**Secrets discipline:** all API keys (Anthropic, Slack, Supabase, ClickUp) live in Vercel's Environment Variables dashboard (shared) and a local `.env` (gitignored) for local dev. Nobody hardcodes a key in source.

Once this is done, all 3 people build against the same live URL, same database, same ClickUp workspace — so partial features are testable together immediately, not just at final integration.

---

## 3. Capture Layer — Chrome Extension

No Google Meet API, no third-party bot service, no 45-minute transcript wait. The extension reads what's already on screen.

**Components:**
- **Content script** on `meet.google.com/*`:
  - Turns on / detects Meet's live captions
  - Observes the caption DOM node, appends each new line (speaker + text + timestamp) to an in-memory buffer
  - Reads the participant panel DOM for attendee names + (if visible) emails
- **Background service worker**:
  - Holds the running transcript buffer for the active tab
  - Detects meeting end (Leave button click / post-call screen)
  - Fires one `POST` to the backend: `{ transcript: [...], attendees: [...], meeting_id, ended_at }`
- **Manifest** (Manifest V3):
  - `permissions`: `activeTab`, `scripting`, `storage`
  - `host_permissions`: `https://meet.google.com/*`
  - Background service worker + one content script entry

**Known constraints to test early, not on demo day:**
- Captions must be toggled on (one click by the meeting host/attendee) — not zero-touch, but far faster than manual note-taking
- Caption DOM selectors aren't a public API — verify them against the live Meet UI in your first hour of building, since Google can change class names without notice
- "Load unpacked" in Chrome dev mode is sufficient for the demo — no Web Store review needed

This POST is the **single entry point** into the rest of the system — everything downstream is unchanged regardless of what triggers it.

---

## 4. Role Identification — Roster Adapter

Don't ask the AI to guess who's a designer vs developer from tone. Extract **names + tasks**, then **resolve** identity against a roster.

- **Mock roster service** (hackathon-realistic choice): a Supabase table of ~10–15 people — `{name, email, slack_id, team: content/design/dev, manager, active_ticket_count}`
- Built with the same call shape a real HRMS (e.g. Keka) API would have, so it's a one-line swap later — a legitimate "pluggable adapter" architecture point for judges, not a shortcut you need to hide
- **Name resolution**: match extracted names against the extension's captured attendee list first (much more reliable than fuzzy-matching a raw transcript), then look up that person's team/role in the roster

---

## 5. Full Pipeline

```
┌───────────────────────────┐
│ Chrome Extension           │  Captures live-caption transcript +
│ (content script + bg       │  attendee list; POSTs on meeting end
│  worker)                   │
└────────────┬────────────────┘
             │ webhook: {transcript, attendees, meeting_id}
             ▼
┌───────────────────────────┐
│ 1. Extraction Service       │  Claude API call → structured JSON:
│    (Claude API)             │  {project_name, deliverables:
│                             │   [{team, task, owner_name}], due_dates}
└────────────┬────────────────┘
             │
             ▼
┌───────────────────────────┐
│ 2. Role Resolution           │  Match owner_name → attendee list →
│    (Roster Adapter)          │  roster lookup → {slack_id, team, manager}
└────────────┬────────────────┘
             │
             ▼
┌───────────────────────────┐
│ 3. Confirmation Bot           │  Slack DM to initiator:
│    (Slack API)                │  "New project detected: [name]. Confirm?"
│                               │  [Yes] [No]
└────────────┬────────────────┘
             │ Yes
             ▼
┌───────────────────────────┐
│ 4. Assignment Engine          │  3 flows:
│                               │  a) 2+ designers in meeting → ask design
│                               │     manager to pick (Slack interactive msg)
│                               │  b) 1 designer present → auto-assign
│                               │  c) 0 designers present → auto-assign by
│                               │     lowest open-ticket count (query ClickUp)
└──────┬────────────────┬────────┘
       ▼                ▼
┌─────────────┐   ┌─────────────────────┐
│ 5. Slack      │   │ 6. ClickUp Ticket    │
│  Workspace    │   │  Creator             │
│  Provisioner  │   │  Parent task +       │
│  - new channel│   │  3 subtasks (Content,│
│  - invite     │   │  Design, Dev) each    │
│  attendees    │   │  with owner + due date│
└──────┬────────┘   └──────────┬───────────┘
       └────────────┬───────────┘
                     ▼
         ┌───────────────────────┐
         │ 7. Notifier             │  Posts in new channel:
         │    (Slack API)          │  "Project created. @x → Content,
         │                        │   @y → Design, @z → Dev. [ClickUp link]"
         └───────────────────────┘
```

**Hosting note:** every box above runs as a Vercel serverless function off the one shared deployment. State (roster, pending confirmations, created project/ticket mappings) persists in the shared Supabase Postgres instance — not in-memory, so any teammate's deployed code sees the same data.

**ClickUp specifics:** create one parent task ("Webinar July 2026"), then create 3 subtasks (Content / Design / Dev) via ClickUp's `parent` field on task creation, each with its own assignee and due date set from the extraction output.

---

## 6. Work Split — 3 People (Assigned)

*Default assignment below — swap freely between yourselves if someone's stronger in a different area.*

| Person | Owns | Deliverable |
|---|---|---|
| **Mansoor — Capture & Extraction** | Chrome extension (content script + background worker) *and* the Claude extraction service | Working extension that POSTs `{transcript, attendees}` on meeting end; extraction service turning that payload into the structured JSON schema |
| **Hari — Slack Bot & Orchestration** | Confirmation bot, channel/invite provisioning, assignment-engine Slack interactions (design-manager-picks flow), notifier | End-to-end Slack experience: confirm → channel created → manager-pick interactive message (if triggered) → final notification |
| **Charan — Roster, Assignment Logic & ClickUp** | Mock roster (Supabase), name-resolution logic, the 3-flow assignment decision logic, ClickUp API integration (parent task + subtasks) | Given a resolved project JSON, correctly assigns owners and creates the ClickUp ticket structure |

This keeps each person's API surface isolated (Chrome extension + Claude / Slack / Supabase + ClickUp) so integration is mostly "pass the JSON object between stages," minimizing merge conflicts with only 3 people to coordinate.

### Mansoor — Capture & Extraction
**Setup:**
- [ ] Clone the shared repo
- [ ] Get an Anthropic API key → add to local `.env` and Vercel env vars
- [ ] Open a real Meet call, inspect the live caption DOM + participant panel in devtools — note actual selectors (don't trust tutorials, verify live)
- [ ] Scaffold `extension/manifest.json`, `content.js`, `background.js` per Section 3

**Build order:** get transcript+attendee capture POSTing to the shared Vercel URL first (even with fake/no extraction logic) → then build the Claude extraction prompt against 2–3 real recorded sample meetings, output matching the JSON schema in Section 5 → then help wire full pipeline integration.

### Hari — Slack Bot & Orchestration
**Setup:**
- [ ] Clone the shared repo
- [ ] Create a Slack app (api.slack.com/apps) in the team's workspace → get bot token + signing secret
- [ ] Add scopes: `channels:manage`, `chat:write`, `users:read`; enable Interactivity pointing at the shared Vercel URL
- [ ] Add Slack secrets to local `.env` and Vercel env vars

**Build order:** basic Slack DM send working first → Yes/No confirmation interactive message + channel creation/invite logic → design-manager-picks interactive message for the 2+ attendee case → wire into full pipeline.

### Charan — Roster, Assignment Logic & ClickUp
**Setup:**
- [ ] Clone the shared repo
- [ ] Get a ClickUp API token + workspace/list ID → add to local `.env` and Vercel env vars
- [ ] Seed the `roster` table in Supabase (10–15 people, mix of busy/free per team, per Section 4)

**Build order:** test ClickUp parent+subtask creation manually via API call first → name resolution against attendee list + all 3 assignment flows against hardcoded test fixtures → wire roster + assignment + ClickUp into full pipeline.

---

## 7. Execution Timeline

**Phase 1 — Foundations (~25%)**
- Mansoor: scaffold extension, verify caption DOM selectors against a real Meet call, get transcript capture working end-to-end (even before extraction logic exists)
- Hari: Slack app setup (bot token, scopes for `channels:manage`, `chat:write`, `users:read`), basic DM send working
- Charan: seed roster table in Supabase (10–15 people, mix of busy/free designers for demo variety), ClickUp workspace + API key, test parent+subtask creation manually via API call

**Phase 2 — Core Logic (~35%)**
- Mansoor: extraction prompt against real captured transcripts (test with 2–3 recorded sample meetings)
- Hari: confirmation Yes/No interactive message; channel creation + invite logic
- Charan: name resolution against attendee list; all 3 assignment flows implemented against test fixtures (don't wait for live data — hardcode a few scenarios first)

**Phase 3 — Integration (~25%)**
- Wire extension → extraction → roster → confirmation → assignment → ClickUp → notify, end to end
- Run at least one real Meet call through the entire pipeline
- Script 2–3 different sample meetings so each assignment flow (manager-pick / auto-assign / workload-based) can be demonstrated

**Phase 4 — Demo Prep (~15%)**
- Pick your best 1–2 live scenarios (the "ask design manager to pick" flow is the most visually interesting for judges)
- Record a backup run of the full flow in case of live Slack/ClickUp/Wi-Fi issues at the venue
- Rehearse the narration: the meeting happens, captions are on, and everything after that — extraction, ticket, assignment, notification — is untouched by human hands except one Slack "Yes"

---

## 8. Cut List (in order, if time runs short)
1. Drop the "design manager picks" interactive Slack flow — fall back to auto-assign only, mention the manager-approval flow as roadmap
2. Simplify roster to a flat hardcoded JS object instead of a Supabase table — same demo effect, less setup
3. If extension caption-capture proves flaky, fall back to feeding a pre-captured transcript into the extraction step live — still shows the AI logic, just skips the live DOM-scraping risk
4. Never cut: extraction → role resolution → assignment → ClickUp ticket → Slack notification. That's the spine of the demo.
