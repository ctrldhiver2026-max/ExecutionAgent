// Health check. TEMPORARY: also carries the Slack name-lookup probe
// (?slackname=...) while diagnosing why lookupUserByName misses real
// members — folded in here because Vercel Hobby caps deployments at 12
// serverless functions and the repo is exactly at the cap (a 13th file
// fails the whole deployment silently). Probe gets removed after use.
import { lookupUserByName } from "../lib/slack.js";

export default async function handler(req, res) {
  const name = req.query.slackname;
  if (name) {
    try {
      const result = await lookupUserByName(name);
      // users.list is a GET-style method (JSON POST bodies get rejected as
      // invalid_arguments — same class of bug as users.lookupByEmail).
      const r = await fetch("https://slack.com/api/users.list?limit=100", {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      });
      const data = await r.json();
      const people = data.ok
        ? (data.members || [])
            .filter((u) => !u.is_bot && !u.deleted && u.id !== "USLACKBOT")
            .map((u) => ({ real_name: u.profile?.real_name || u.real_name || null, display_name: u.profile?.display_name || null }))
        : { usersListError: data.error };
      res.status(200).json({ lookedUp: name, result, workspaceNames: people });
      return;
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
      return;
    }
  }
  res.status(200).json({ status: "ok", service: "execution-agent" });
}
