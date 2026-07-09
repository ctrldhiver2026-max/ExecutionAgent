// lib/google.js
// Google Calendar helpers (plain fetch, no SDK — repo convention).
// OAuth refresh-token flow against the shared team Google account.
// Credential setup steps: README.md "Calendar watcher setup"

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";

let cachedToken = null; // { token, expiresAt } — warm serverless containers reuse this

export async function getAccessToken() {
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    throw new Error("Google credentials not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN)");
  }
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.token;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    // Must be form-encoded, not JSON — Google's token endpoint rejects JSON bodies.
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.error === "invalid_grant") {
      // A consent screen left in "Testing" status issues refresh tokens that
      // expire after 7 days — the most likely cause here. Loud on purpose.
      console.error(
        "[google] ✋ REFRESH TOKEN EXPIRED OR REVOKED (invalid_grant). " +
          "Re-mint it via the OAuth Playground and update GOOGLE_REFRESH_TOKEN in Vercel " +
          "(README.md — 'Calendar watcher setup', token expiry note)."
      );
    }
    throw new Error(`Google token refresh failed: ${res.status} ${data.error || ""}`);
  }
  cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

/**
 * Upcoming events on the shared calendar within the lookahead window,
 * soonest first. Normalized to the fields the watcher needs.
 */
export async function listUpcomingEvents(lookaheadMinutes = 24 * 60) {
  const token = await getAccessToken();
  const now = new Date();
  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: new Date(now.getTime() + lookaheadMinutes * 60_000).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
  });
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    throw new Error(`Google events.list failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return (data.items || []).map((e) => ({
    id: e.id,
    title: e.summary || "(untitled meeting)",
    start: e.start?.dateTime || e.start?.date || null,
    end: e.end?.dateTime || e.end?.date || null,
    meetLink: e.hangoutLink || null,
    meetCode: e.conferenceData?.conferenceId || null,
    organizer: e.organizer?.email || null,
    attendees: (e.attendees || []).map((a) => ({
      email: a.email,
      name: a.displayName || null,
      response: a.responseStatus || null,
    })),
  }));
}
