// Feeds the dashboard's People section. Public/read-only — see
// api/roster/update.js for the corresponding edit endpoint.
import { listRoster } from "../../lib/db.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const roster = await listRoster();
    res.status(200).json({ roster });
  } catch (err) {
    console.error("[roster/list] failed", err);
    res.status(500).json({ error: "Failed to load roster" });
  }
}
