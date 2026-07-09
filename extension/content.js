// Runs on meet.google.com/*. Captures live captions + attendee names into an
// in-memory buffer and streams updates to the background service worker.
// Selectors verified against a live Meet call on 2026-07-09 — Meet's class
// names are obfuscated and can change without notice, so we anchor on
// semantic attributes (role/aria-label) wherever possible and keep the
// obfuscated-class lookups isolated to small helper functions.

(() => {
  const CAPTIONS_REGION_SELECTOR = '[role="region"][aria-label="Captions"]';
  const CAPTION_LINE_SELECTOR = ':scope > div';
  const SPEAKER_NAME_SELECTOR = '.adE6rb [class]'; // wraps avatar img + name div
  const CAPTION_TEXT_SELECTOR = '.ygicle';
  const PEOPLE_PANEL_ROW_SELECTOR = '.SKWIhd';
  const PEOPLE_PANEL_NAME_SELECTOR = '.zWGUib';
  const VIDEO_TILE_NAME_SELECTOR = '.ns17te'; // on-screen name tag, always visible

  const transcript = []; // [{ speaker, text, ts }]
  const lineIndexByNode = new WeakMap(); // caption block DOM node -> transcript index
  const attendees = new Set();

  function meetingIdFromUrl() {
    return location.pathname.replace(/^\/+/, '').split('?')[0];
  }

  function captureCaptionLines() {
    const region = document.querySelector(CAPTIONS_REGION_SELECTOR);
    if (!region) return;

    const blocks = region.querySelectorAll(CAPTION_LINE_SELECTOR);
    blocks.forEach((block) => {
      const nameEl = block.querySelector(SPEAKER_NAME_SELECTOR);
      const textEl = block.querySelector(CAPTION_TEXT_SELECTOR);
      if (!textEl || !textEl.textContent.trim()) return;

      const speaker = nameEl?.textContent.trim() || 'Unknown';
      const text = textEl.textContent.trim();
      const ts = new Date().toISOString();

      const existingIndex = lineIndexByNode.get(block);
      if (existingIndex !== undefined) {
        // Meet mutates the same block while a speaker keeps talking —
        // update in place so we end up with the final utterance text.
        transcript[existingIndex] = { speaker, text, ts: transcript[existingIndex].ts };
      } else {
        lineIndexByNode.set(block, transcript.length);
        transcript.push({ speaker, text, ts });
      }
    });
  }

  function captureAttendees() {
    document.querySelectorAll(`${PEOPLE_PANEL_ROW_SELECTOR} ${PEOPLE_PANEL_NAME_SELECTOR}`).forEach((el) => {
      const name = el.textContent.trim().replace(/\s*\(You\)$/, '');
      if (name) attendees.add(name);
    });
    document.querySelectorAll(VIDEO_TILE_NAME_SELECTOR).forEach((el) => {
      const name = el.textContent.trim().replace(/\s*\(You\)$/, '');
      if (name) attendees.add(name);
    });
  }

  // If the extension is reloaded while this tab stays open, chrome.runtime
  // goes away out from under the content script — stop working instead of
  // throwing on every subsequent observer tick.
  function isExtensionContextValid() {
    return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
  }

  function teardown() {
    captionsObserver.disconnect();
    endScreenObserver.disconnect();
    clearInterval(attendeePoll);
    clearInterval(attachPoll);
  }

  function sendUpdate() {
    if (!isExtensionContextValid()) return teardown();
    chrome.runtime.sendMessage({
      type: 'TRANSCRIPT_UPDATE',
      meetingId: meetingIdFromUrl(),
      transcript,
      attendees: Array.from(attendees),
    });
  }

  function handlePotentialEnd() {
    if (!isExtensionContextValid()) return teardown();
    chrome.runtime.sendMessage({
      type: 'MEETING_ENDED',
      meetingId: meetingIdFromUrl(),
      transcript,
      attendees: Array.from(attendees),
      endedAt: new Date().toISOString(),
    });
  }

  // Leave button is semantically labeled — more stable than its obfuscated class.
  document.addEventListener(
    'click',
    (e) => {
      const leaveBtn = e.target.closest('button[aria-label*="Leave call" i]');
      if (leaveBtn) handlePotentialEnd();
    },
    true
  );

  // Fallback: detect the post-call screen by its copy, in case the click handler misses it.
  const endScreenObserver = new MutationObserver(() => {
    if (/you left the meeting|return to home screen/i.test(document.body.innerText)) {
      handlePotentialEnd();
      endScreenObserver.disconnect();
    }
  });
  endScreenObserver.observe(document.body, { childList: true, subtree: true });

  const captionsObserver = new MutationObserver(() => {
    captureCaptionLines();
    sendUpdate();
  });

  function attachCaptionsObserver() {
    const region = document.querySelector(CAPTIONS_REGION_SELECTOR);
    if (region) {
      captionsObserver.observe(region, { childList: true, subtree: true, characterData: true });
      return true;
    }
    return false;
  }

  // Captions region only exists once the user turns captions on — poll until it appears.
  const attachPoll = setInterval(() => {
    if (attachCaptionsObserver()) clearInterval(attachPoll);
  }, 2000);

  // Attendees (People panel / video tiles) can change independent of captions.
  const attendeePoll = setInterval(() => {
    captureAttendees();
    sendUpdate();
  }, 3000);
})();
