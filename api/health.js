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
      // Full pagination, then substring-match on the query's first token so
      // we can SEE what this person's Slack profile actually says.
      const token = name.trim().toLowerCase().split(/\s+/)[0];
      const matches = [];
      let cursor;
      do {
        const params = new URLSearchParams({ limit: "200", ...(cursor && { cursor }) });
        const r = await fetch(`https://slack.com/api/users.list?${params}`, {
          headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
        });
        const data = await r.json();
        if (!data.ok) {
          res.status(200).json({ lookedUp: name, result, usersListError: data.error });
          return;
        }
        for (const u of data.members || []) {
          if (u.is_bot || u.deleted || u.id === "USLACKBOT") continue;
          const real = (u.profile?.real_name || u.real_name || "").toLowerCase();
          const display = (u.profile?.display_name || "").toLowerCase();
          if (real.includes(token) || display.includes(token)) {
            matches.push({ real_name: u.profile?.real_name || u.real_name || null, display_name: u.profile?.display_name || null });
          }
        }
        cursor = data.response_metadata?.next_cursor || undefined;
      } while (cursor);
      res.status(200).json({ lookedUp: name, result, substringMatches: matches });
      return;
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
      return;
    }
  }
  res.status(200).json({ status: "ok", service: "execution-agent" });
}
