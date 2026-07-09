// api/slack/events.js
// Slack Events API Request URL → https://execution-agent.vercel.app/api/slack/events
//
// Requires the `message.channels` event subscription + `channels:history`
// bot scope (Reinstall to Workspace after adding either).
//
// Review-approval flow: an assignee posts a plain message in their
// project's channel mentioning whoever should review it, with a link
// ("@mansoor here's the landing page: <figma link>") — no slash command,
// no button. If that channel belongs to a tracked project AND the sender
// currently has exactly one open ClickUp subtask assigned to them in it,
// we post a Yes/No "Is this final?" prompt aimed at the mentioned person.
// Yes -> subtask marked complete (api/slack/interactivity.js handles the
// button click); No -> assignee gets a DM, nothing else changes.
import { verifySlackSignature, postMessage } from "../../lib/slack.js";
import { getProjectByChannelId, getRosterMemberBySlackId } from "../../lib/db.js";
import { findClickUpMemberIdByEmail, findOpenSubtaskForAssignee } from "../../lib/clickup.js";

export const config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// Slack auto-linkifies both mentions and URLs in event text:
// "<@U0123|name>" or "<@U0123>", and "<https://example.com|label>" or "<https://example.com>".
const MENTION_RE = /<@([A-Z0-9]+)(?:\|[^>]*)?>/;
const URL_RE = /<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/;

async function handleChannelMessage(event) {
  // Only plain human messages — no edits/deletes/bot posts (avoids reacting
  // to our own "Is this final?" / confirmation messages and looping).
  if (event.subtype || event.bot_id || !event.text || !event.user) return;

  const mentionMatch = event.text.match(MENTION_RE);
  const urlMatch = event.text.match(URL_RE);
  if (!mentionMatch || !urlMatch) return; // not a "share for review" message

  const project = await getProjectByChannelId(event.channel);
  if (!project || !project.clickup_task_id) return; // not a tracked project channel

  const sender = await getRosterMemberBySlackId(event.user);
  if (!sender || !sender.email) {
    console.log(`[slack/events] review message from unresolvable sender ${event.user} — skipping`);
    return;
  }

  const clickupMemberId = await findClickUpMemberIdByEmail(sender.email);
  if (!clickupMemberId) {
    console.log(`[slack/events] sender ${sender.email} isn't a ClickUp list member — skipping review prompt`);
    return;
  }

  const subtask = await findOpenSubtaskForAssignee(project.clickup_task_id, clickupMemberId);
  if (!subtask) {
    console.log(`[slack/events] no single open subtask for ${sender.email} in project "${project.project_name}" — skipping (ambiguous or none)`);
    return;
  }

  const approverSlackId = mentionMatch[1];
  await postMessage(event.channel, `Is "${subtask.name}" final?`, [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:eyes: <@${approverSlackId}> — is *${subtask.name}* ready to mark complete?` },
    },
    {
      type: "actions",
      block_id: "deliverable_review",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Yes, final" },
          action_id: "approve_deliverable",
          value: `${subtask.id}|${event.user}|${approverSlackId}|${subtask.name}`,
        },
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: "No, not yet" },
          action_id: "reject_deliverable",
          value: `${subtask.id}|${event.user}|${approverSlackId}|${subtask.name}`,
        },
      ],
    },
  ]);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const rawBody = await readRawBody(req);
  const body = JSON.parse(rawBody);

  // Slack's URL verification handshake — must echo the challenge.
  // (Slack does NOT sign this consistently across retries in some setups,
  // so handle it before signature rejection.)
  if (body.type === "url_verification") {
    return res.status(200).json({ challenge: body.challenge });
  }

  if (!verifySlackSignature(req, rawBody)) {
    return res.status(401).json({ error: "invalid signature" });
  }

  // Slack retries an event if it doesn't get a response within ~3s — this
  // handler's ClickUp calls (list members, fetch every subtask) can run
  // long enough to trigger that on a bigger project, which would otherwise
  // post the same review prompt twice. Ack the retry without reprocessing,
  // same guard api/slack/interactivity.js already uses.
  if (req.headers["x-slack-retry-num"]) {
    return res.status(200).end();
  }

  // Await before acking (same reasoning as api/slack/interactivity.js —
  // Vercel Fluid compute tears the invocation down right after the
  // response flushes, silently dropping work queued after res.end()).
  if (body.event && body.event.type === "message") {
    try {
      await handleChannelMessage(body.event);
    } catch (err) {
      console.error("[slack/events] message handling failed (non-fatal)", err);
    }
  }

  res.status(200).end();
}
