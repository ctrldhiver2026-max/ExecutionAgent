// Runs on meet.google.com/*. Captures live captions + attendee names into an
// in-memory buffer and streams updates to the background service worker.
// Selectors verified against a live Meet call on 2026-07-09 — Meet's class
// names are obfuscated and can change without notice, so we anchor on
// semantic attributes (role/aria-label) wherever possible and keep the
// obfuscated-class lookups isolated to small helper functions.

(() => {
  const CAPTIONS_REGION_SELECTOR = '[role="region"][aria-label="Captions"]';
  const CAPTION_LINE_SELECTOR = ':scope > div';
  // .adE6rb wraps an avatar <img>, sometimes an icon <div> (rendered as
  // Material Symbols ligature text like "domain_disabled" — not a name!),
  // and the actual name <div class="KcIKyf jxFHg">. Target that class
  // directly instead of a generic 'div' wildcard.
  const SPEAKER_NAME_SELECTOR = '.adE6rb .KcIKyf';
  const CAPTION_TEXT_SELECTOR = '.ygicle';
  const PEOPLE_PANEL_ROW_SELECTOR = '.SKWIhd';
  const PEOPLE_PANEL_NAME_SELECTOR = '.zWGUib';

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

      // Whoever speaks is definitely an attendee — this is more reliable
      // than the People panel / video tiles, which aren't always rendered.
      // Meet captions your own speech as the placeholder "You", not your
      // real name — that's not an identity, so don't count it as one.
      if (speaker !== 'Unknown' && speaker !== 'You') {
        attendees.add(speaker.replace(/\s*\(You\)$/, ''));
      }

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
    // People panel rows are the only reliable structured source — video-tile
    // "name tag" elements turned out to be a UI badge overlay that matches
    // unrelated on-screen text, so we don't use them. Caption speakers
    // (captureCaptionLines) fill the gap when the panel isn't open.
    document.querySelectorAll(`${PEOPLE_PANEL_ROW_SELECTOR} ${PEOPLE_PANEL_NAME_SELECTOR}`).forEach((el) => {
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

  // Most users never remember to click CC themselves — auto-click it for them
  // rather than depend on that. Button is toggled via aria-pressed; only
  // click if captions aren't already on.
  function autoEnableCaptions() {
    if (document.querySelector(CAPTIONS_REGION_SELECTOR)) return;
    const ccButton = document.querySelector('button[aria-label*="captions" i]');
    if (ccButton && ccButton.getAttribute('aria-pressed') !== 'true') {
      ccButton.click();
    }
  }

  // Captions region only exists once captions are on — poll (and try to
  // auto-enable them) until it appears. The CC button itself may not be
  // mounted yet right after page load, hence the retry loop.
  const attachPoll = setInterval(() => {
    autoEnableCaptions();
    if (attachCaptionsObserver()) clearInterval(attachPoll);
  }, 2000);

  // Auto-open the People panel once so silent (non-speaking) attendees still
  // get captured, not just active speakers. NOTE: this button's aria-label
  // wasn't directly verified against the live DOM (unlike the CC button) —
  // if attendee capture stops picking up panel rows, check this selector
  // first, since Meet may label it differently than assumed here.
  let peoplePanelOpenAttempted = false;
  function autoOpenPeoplePanel() {
    if (peoplePanelOpenAttempted) return;
    if (document.querySelector(PEOPLE_PANEL_ROW_SELECTOR)) {
      peoplePanelOpenAttempted = true;
      return;
    }
    const peopleButton = document.querySelector('button[aria-label*="people" i]:not([aria-label*="add" i])');
    if (peopleButton) {
      peopleButton.click();
      peoplePanelOpenAttempted = true;
    }
  }

  // Attendees (People panel) can change independent of captions.
  const attendeePoll = setInterval(() => {
    autoOpenPeoplePanel();
    captureAttendees();
    sendUpdate();
  }, 3000);
})();
