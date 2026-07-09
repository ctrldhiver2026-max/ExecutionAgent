// Dashboard's People section calls this to set/correct someone's team when
// auto-inference (lib/roster.js inferMissingTeams) didn't catch it or got
// it wrong — the manual-edit fallback CLAUDE.md's role-identification asks for.
import { updateRosterMember } from "../../lib/db.js";

const VALID_TEAMS = ["content", "design", "dev"];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Cross-origin POSTs with a JSON body trigger a CORS preflight — only
  // relevant when the dashboard is opened as a local file / preview (see
  // ROSTER_UPDATE_URL fallback in public/index.html); same-origin on the
  // real deployment never hits this.
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { id, team } = req.body || {};
  if (typeof id !== "string" || !id || !VALID_TEAMS.includes(team)) {
    res.status(400).json({ error: "id (string) and team (content|design|dev) are required" });
    return;
  }

  try {
    const updated = await updateRosterMember(id, { team });
    if (!updated) {
      res.status(404).json({ error: "No roster row with that id" });
      return;
    }
    res.status(200).json({ roster: updated });
  } catch (err) {
    console.error("[roster/update] failed", err);
    res.status(500).json({ error: "Failed to update role" });
  }
}
