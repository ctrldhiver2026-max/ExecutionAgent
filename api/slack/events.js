// api/slack/events.js
// Slack Events API Request URL → https://execution-agent.vercel.app/api/slack/events
//
// You mainly need this to pass Slack's one-time `url_verification` challenge
// when saving the Request URL in the app config. Real event handling can be
// added later if the team wires ClickUp status-change → Slack updates.

import { verifySlackSignature } from "../../lib/slack.js";

export const config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
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

  // Ack immediately; add event routing here if needed later.
  res.status(200).end();
}
