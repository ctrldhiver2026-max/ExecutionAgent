// TEMPORARY — diagnosing why lookupUserByName misses real workspace members
// (seen live: "Hari krishnan" resolved to null during the replay test).
// Returns the lookup result for ?name= plus the workspace's actual
// real/display names so the mismatch becomes visible. Remove after use.
import { lookupUserByName } from "../../lib/slack.js";

export default async function handler(req, res) {
  const name = req.query.name || "";
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
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}
