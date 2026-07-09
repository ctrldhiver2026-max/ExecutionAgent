// TEMPORARY — verifies the users:read.email Slack scope is actually
// working after being granted. Remove once confirmed (tracked in the
// commit that adds this file).
import { lookupUserByEmail } from "../../lib/slack.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const email = req.query.email;
  if (!email) {
    res.status(400).json({ error: "email query param required" });
    return;
  }
  try {
    const result = await lookupUserByEmail(email);
    res.status(200).json({ email, result });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}
