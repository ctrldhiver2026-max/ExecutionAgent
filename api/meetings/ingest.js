// Stub entry point for the extension's meeting-end POST.
// Logs the payload for now; real extraction (Claude call -> structured JSON,
// per Section 5 of CLAUDE.md) gets wired in next.
export default function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { meeting_id, transcript, attendees, ended_at } = req.body || {};
  console.log('[meetings/ingest]', {
    meeting_id,
    ended_at,
    attendeeCount: attendees?.length ?? 0,
    transcriptLines: transcript?.length ?? 0,
  });

  res.status(200).json({ status: 'received' });
}
