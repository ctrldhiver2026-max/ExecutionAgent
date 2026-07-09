// TEMPORARY debug endpoint to directly test Slack identity resolution against
// production credentials, since serverless log capture proved unreliable for
// diagnosing the Hari roster/slack_id issue. Delete once resolved.
import { lookupUserByEmail, lookupUserByName } from "../../lib/slack.js";

export default async function handler(req, res) {
  const { email, name } = req.query;
  const result = {};
  try {
    if (email) {
      result.byEmail = await lookupUserByEmail(String(email));
    }
    if (name) {
      result.byName = await lookupUserByName(String(name));
    }
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
