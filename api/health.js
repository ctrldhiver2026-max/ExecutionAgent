// Health check. TEMPORARY: also carries a Slack identity probe (?probe=hari)
// while diagnosing why Hari never resolves — folded in here because Vercel
// Hobby caps deployments at 12 serverless functions and the repo sits
// exactly at the cap (a 13th file fails the whole deployment silently, as
// api/debug/lookup.js just did). Probe gets removed after use.
import { lookupUserByEmail, lookupUserByName } from "../lib/slack.js";

export default async function handler(req, res) {
  const probe = req.query.probe;
  if (probe) {
    try {
      const [byGrexit, byHiverhq, byName] = await Promise.all([
        lookupUserByEmail("hari.k@grexit.com").catch((e) => ({ error: e.message })),
        lookupUserByEmail("hari.k@hiverhq.com").catch((e) => ({ error: e.message })),
        lookupUserByName("Hari K").catch((e) => ({ error: e.message })),
      ]);
      res.status(200).json({ byGrexit, byHiverhq, byName });
      return;
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
      return;
    }
  }
  res.status(200).json({ status: "ok", service: "execution-agent" });
}
