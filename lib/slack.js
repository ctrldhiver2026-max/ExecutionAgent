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
  try {
    const data = await slackApi("users.lookupByEmail", { email });
    return { id: data.user.id, name: data.user.real_name || data.user.name };
  } catch (err) {
    if (String(err.message).includes("users_not_found")) return null;
    if (String(err.message).includes("missing_scope")) {
      console.error(
        `[slack] users.lookupByEmail missing the users:read.email scope — ` +
          `add it in api.slack.com/apps → OAuth & Permissions, then Reinstall to Workspace.`
      );
      return null;
    }
    throw err;
  }
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
 * assignments: [{ team: "Content", slack_id: "U123" }, ...]
 * attendees (optional): [{ name, slack_id, team }] — everyone captured from
 * the meeting, not just the 3 resolved owners, so the whole room gets pinged.
 */
export async function postProjectKickoff(channelId, projectName, assignments, clickupUrl, attendees = []) {
  const ownerLines = assignments
    .map((a) => `• <@${a.slack_id}> → *${a.team}*`)
    .join("\n");

  const ownerIds = new Set(assignments.map((a) => a.slack_id));
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
