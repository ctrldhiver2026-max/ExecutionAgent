// Background service worker (Manifest V3). Holds the latest transcript/attendee
// state per tab and fires the single POST into the pipeline when a meeting ends.

const BACKEND_URL = 'https://execution-agent.vercel.app/api/meetings/ingest';
// Shared secret matching the INGEST_SECRET env var on Vercel. Only enforced
// server-side once that env var is set — keeps random internet clients from
// burning our Claude quota via the public ingest URL.
const INGEST_TOKEN = 'ctrld-hiver-2026-ingest';

const stateByTab = new Map(); // tabId -> { meetingId, transcript, attendees }

chrome.runtime.onMessage.addListener((message, sender) => {
  const tabId = sender.tab?.id;
  if (!tabId) return;

  if (message.type === 'TRANSCRIPT_UPDATE') {
    stateByTab.set(tabId, {
      meetingId: message.meetingId,
      transcript: message.transcript,
      attendees: message.attendees,
    });
    console.log(
      `[execution-agent] update: ${message.transcript.length} lines, ${message.attendees.length} attendees`
    );
  }

  if (message.type === 'MEETING_ENDED') {
    console.log('[execution-agent] meeting ended, posting payload', message);
    postMeeting({
      meeting_id: message.meetingId,
      transcript: message.transcript,
      attendees: message.attendees,
      ended_at: message.endedAt,
    });
    stateByTab.delete(tabId);
  }
});

// Fallback: if the tab is closed/navigated away without a clean "Leave call"
// click (e.g. window closed), flush whatever we last captured for it.
chrome.tabs.onRemoved.addListener((tabId) => {
  const state = stateByTab.get(tabId);
  if (!state) return;
  postMeeting({
    meeting_id: state.meetingId,
    transcript: state.transcript,
    attendees: state.attendees,
    ended_at: new Date().toISOString(),
  });
  stateByTab.delete(tabId);
});

async function postMeeting(payload) {
  // Defense-in-depth against the content script's own guard: only POST for
  // real meeting codes ("abc-defg-hij"). Meet's homepage path is "/landing",
  // which a stale pre-guard content script can still report — that's how a
  // phantom empty meeting named "landing" ended up on the dashboard.
  if (!/^[a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4}$/i.test(payload.meeting_id || '')) {
    console.log(`[execution-agent] skipping POST — "${payload.meeting_id}" is not a meeting code`);
    return;
  }
  try {
    await fetch(BACKEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-token': INGEST_TOKEN },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('[execution-agent] failed to POST meeting payload', err);
  }
}
