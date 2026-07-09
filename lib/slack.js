// lib/slack.js
// Slack helpers: request signature verification + thin Web API wrappers.
// No SDK dependency — plain fetch keeps the Vercel bundle tiny.

import crypto from "crypto";

const SLACK_API = "https://slack.com/api";
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

/**
 * Verify a request actually came from Slack.
 * MUST be called with the RAW body string (before JSON/urlencoded parsing).
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function verifySlackSignature(req, rawBody) {
  const timestamp = req.headers["x-slack-request-timestamp"];
  const slackSig = req.headers["x-slack-signature"];
  if (!timestamp || !slackSig) return false;

  // Reject replays older than 5 minutes
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 * 5) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const mySig =
    "v0=" +
    crypto.createHmac("sha256", SIGNING_SECRET).update(base).digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(mySig), Buffer.from(slackSig));
  } catch {
    return false;
  }
}

/** Generic Slack Web API caller. Throws on Slack-level errors so failures are loud. */
export async function slackApi(method, payload) {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${BOT_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Slack ${method} failed: ${data.error}`);
  }
  return data;
}

/** Open (or fetch) a DM channel with a user, returns the channel id. */
export async function openDm(userId) {
  const data = await slackApi("conversations.open", { users: userId });
  return data.channel.id;
}

/**
 * Resolve a Slack user id from an email address — this is what makes
 * attendee mapping zero-touch (no one hand-types a Slack ID anywhere).
 * Requires the `users:read.email` bot scope; returns null (not a throw)
 * for the common, expected case of an email with no Slack account
 * (external attendee, wrong scope not yet granted, etc.) rather than
 * blowing up the whole pipeline over one unmatched person.
 */
export async function lookupUserByEmail(email) {
  if (!email) return null;
  // users.lookupByEmail is one of Slack's older-style methods — it wants the
  // email as a query param, not JSON in the POST body like slackApi() sends
  // everywhere else (confirmed live: JSON body → invalid_arguments for every
  // email, real or fake, i.e. it never even reads the argument).
  const url = `${SLACK_API}/users.lookupByEmail?${new URLSearchParams({ email })}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${BOT_TOKEN}` } });
  const data = await res.json();
  if (!data.ok) {
    if (data.error === "users_not_found") return null;
    if (data.error === "missing_scope") {
      console.error(
        `[slack] users.lookupByEmail missing the users:read.email scope — ` +
          `add it in api.slack.com/apps → OAuth & Permissions, then Reinstall to Workspace.`
      );
      return null;
    }
    throw new Error(`Slack users.lookupByEmail failed: ${data.error}`);
  }
  return { id: data.user.id, name: data.user.real_name || data.user.name };
}

// In-memory cache for listAllUsers() — a full workspace list is a slow call
// to repeat per lookup; warm serverless containers reuse this.
let cachedUserList = null;

async function listAllUsers() {
  if (cachedUserList) return cachedUserList;
  const users = [];
  let cursor;
  do {
    const params = new URLSearchParams({ limit: "200", ...(cursor && { cursor }) });
    const res = await fetch(`${SLACK_API}/users.list?${params}`, {
      headers: { Authorization: `Bearer ${BOT_TOKEN}` },
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack users.list failed: ${data.error}`);
    users.push(...data.members);
    cursor = data.response_metadata?.next_cursor || undefined;
  } while (cursor);
  cachedUserList = users.filter((u) => !u.is_bot && !u.deleted && u.id !== "USLACKBOT");
  return cachedUserList;
}

/**
 * Resolve a Slack user id purely from a display name — the fallback for
 * someone named in a meeting but never actually on the call (no email
 * available at all, e.g. "let Shweta take the video"). Only needs the
 * existing `users:read` scope (not the email one), since it reads the
 * whole member list rather than looking up by email. Exact match only —
 * deliberately not fuzzy, so it doesn't silently DM the wrong person.
 */
export async function lookupUserByName(name) {
  if (!name) return null;
  const target = name.trim().toLowerCase();
  const users = await listAllUsers().catch((err) => {
    console.error("[slack] users.list failed (non-fatal)", err);
    return [];
  });
  const match = users.find((u) => {
    const real = (u.profile?.real_name || u.real_name || "").trim().toLowerCase();
    const display = (u.profile?.display_name || "").trim().toLowerCase();
    return (real && real === target) || (display && display === target);
  });
  return match ? { id: match.id, name: match.profile?.real_name || match.real_name || name } : null;
}

/** Send a plain text or Block Kit message. */
export async function postMessage(channel, text, blocks) {
  return slackApi("chat.postMessage", { channel, text, ...(blocks && { blocks }) });
}

/**
 * Send the "New project detected — confirm?" DM to the meeting initiator.
 * confirmationId = row id in Supabase pending_confirmations, carried in
 * the button `value` so the interactivity handler can look the project up.
 */
/**
 * Pipeline step 2's soft notification — DMs a person directly that a
 * meeting they're invited to is coming up. Sent per-invitee (resolved via
 * real calendar email -> Slack ID, see lib/roster.js), not a shared
 * channel — no manual "create a channel, invite the bot" setup needed.
 */
export async function notifyUpcomingMeeting(userId, { title, whenText }) {
  const channel = await openDm(userId);
  return postMessage(channel, `Upcoming: ${title}`, [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `:calendar: *${title}*\n${whenText}\n` +
          `_Execution Agent will capture this call and turn it into tickets automatically._`,
      },
    },
  ]);
}

export async function sendConfirmationDm(userId, projectName, confirmationId) {
  const channel = await openDm(userId);
  return postMessage(channel, `New project detected: ${projectName}. Confirm?`, [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:sparkles: *New project detected:* ${projectName}\nShould I set up the Slack channel and ClickUp tickets?`,
      },
    },
    {
      type: "actions",
      block_id: "project_confirmation",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Yes, create it" },
          action_id: "confirm_project",
          value: confirmationId,
        },
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: "No, ignore" },
          action_id: "reject_project",
          value: confirmationId,
        },
      ],
    },
  ]);
}

/**
 * Send the design-manager-pick interactive message (2+ designers case).
 * designers: [{ name, slack_id }]
 */
export async function sendManagerPickMessage(managerId, projectName, confirmationId, designers) {
  const channel = await openDm(managerId);
  return postMessage(channel, `Pick a designer for ${projectName}`, [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:art: *${projectName}* has ${designers.length} designers in the meeting.\nWho should own the design task?`,
      },
    },
    {
      type: "actions",
      block_id: "designer_pick",
      elements: designers.map((d) => ({
        type: "button",
        text: { type: "plain_text", text: d.name },
        action_id: `pick_designer_${d.slack_id}`,
        // pack both ids into value: "confirmationId|slackId"
        value: `${confirmationId}|${d.slack_id}`,
      })),
    },
  ]);
}

/** Create a channel, invite attendees, return channel id. Channel names must be lowercase, no spaces. */
export async function createProjectChannel(projectName, attendeeSlackIds) {
  const name = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70); // Slack limit is 80 chars; leave headroom for suffixes

  let channelId;
  try {
    const data = await slackApi("conversations.create", { name });
    channelId = data.channel.id;
  } catch (err) {
    // name_taken is common when re-running demos — retry with a suffix
    if (String(err.message).includes("name_taken")) {
      const data = await slackApi("conversations.create", {
        name: `${name}-${Date.now().toString().slice(-4)}`,
      });
      channelId = data.channel.id;
    } else {
      throw err;
    }
  }

  if (attendeeSlackIds?.length) {
    await slackApi("conversations.invite", {
      channel: channelId,
      users: attendeeSlackIds.join(","),
    });
  }
  return channelId;
}

/**
 * Personal heads-up DM once the project pipeline finishes — separate from
 * Slack's own ambient "added to a channel" notice, this tells each attendee
 * specifically what they're on the hook for (or that nothing's assigned to
 * them yet, if so).
 */
export async function notifyAttendeePersonally(userId, { projectName, channelId, task, clickupUrl }) {
  const channel = await openDm(userId);
  const taskLine = task
    ? `\n*Your task:* ${task}`
    : "\n_You're on the team — no specific deliverable assigned to you yet._";
  return postMessage(channel, `${projectName} is set up`, [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:white_check_mark: *${projectName}* is set up — you're in <#${channelId}>.${taskLine}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open in ClickUp" },
          url: clickupUrl,
          action_id: "open_clickup_personal",
        },
      ],
    },
  ]);
}

/**
 * Final notifier — post the kickoff message in the new channel.
 * owners: [{ task, team, slack_id, name }, ...] — one per deliverable, not
 * one per team (two deliverables on the same team can have different owners).
 * attendees (optional): [{ name, slack_id, team }] — everyone captured from
 * the meeting, so the whole room gets pinged, not just the resolved owners.
 */
export async function postProjectKickoff(channelId, projectName, owners, clickupUrl, attendees = []) {
  const ownerLines = owners
    .map((o) => `• *${o.task}* → ${o.slack_id ? `<@${o.slack_id}>` : `_${o.name}_ (no Slack link yet)`}`)
    .join("\n");

  const ownerIds = new Set(owners.map((o) => o.slack_id).filter(Boolean));
  const others = attendees.filter((a) => a.slack_id && !ownerIds.has(a.slack_id));
  const attendeeLine = others.length
    ? `\n:busts_in_silhouette: Also on the call: ${others.map((a) => `<@${a.slack_id}>`).join(", ")}`
    : "";

  return postMessage(channelId, `Project ${projectName} created`, [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:rocket: *${projectName}* is live.\n${ownerLines}${attendeeLine}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open in ClickUp" },
          url: clickupUrl,
          action_id: "open_clickup",
        },
      ],
    },
  ]);
}
