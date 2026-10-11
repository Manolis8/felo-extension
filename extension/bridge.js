// Bridge between MAIN world (content-script.js) and ISOLATED world (chrome APIs)
// Listens for postMessage from MAIN world, relays to background via chrome.runtime

// Verify chrome is available
if (typeof chrome === 'undefined' || !chrome.runtime) {
  console.error('[Bridge] CRITICAL: chrome.runtime not available!');
  console.error('[Bridge] chrome:', typeof chrome);
  console.error('[Bridge] chrome.runtime:', chrome?.runtime);
  throw new Error('Bridge requires chrome.runtime API');
}

console.log('[Bridge] Chrome API available. Ready to relay messages.');

window.addEventListener('message', (event) => {
  // Only accept messages from the same window (not iframes/external)
  if (event.source !== window) return;

  if (!event.data || !event.data.type) return;

  const messageType = event.data.type;

  // ===== CONTENT SCRIPT READY NOTIFICATION =====
  if (messageType === 'CONTENT_SCRIPT_READY') {
    console.log('[Bridge] Content script ready on:', event.data.hostname);

    // Relay to background to mark this site as recordable
    chrome.runtime.sendMessage({
      type: 'CONTENT_SCRIPT_READY',
      url: event.data.url,
      hostname: event.data.hostname
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[Bridge] Failed to report content script ready:', chrome.runtime.lastError);
      }
    });
    return;  // Don't continue processing
  }

  // ===== RECORDING REQUEST MESSAGES (relay to background) =====
  const recordingRequests = ['START_RECORDING', 'RECORD_EVENT', 'STOP_RECORDING', 'CLEAR_SESSION'];
  if (recordingRequests.includes(messageType)) {
    console.log('[Bridge] Relaying message to background:', messageType);

    chrome.runtime.sendMessage(event.data, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[Bridge] Background error:', chrome.runtime.lastError);
        window.postMessage({
          type: 'RECORDING_RESPONSE',
          originalType: messageType,
          success: false,
          error: chrome.runtime.lastError.message
        }, '*');
        return;
      }

      console.log('[Bridge] Background response received:', messageType);

      window.postMessage({
        type: 'RECORDING_RESPONSE',
        originalType: messageType,
        success: response.success,
        data: response
      }, '*');
    });
    return;
  }

  // ===== RECORDING STATE QUERY (relay to background) =====
  if (messageType === 'GET_RECORDING_STATE') {
    console.log('[Bridge] Querying recording state from background');

    chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATE' }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[Bridge] Background error:', chrome.runtime.lastError);
        window.postMessage({
          type: 'RECORDING_STATE_RESPONSE',
          state: null
        }, '*');
        return;
      }

      console.log('[Bridge] Returning recording state:', response);

      window.postMessage({
        type: 'RECORDING_STATE_RESPONSE',
        state: response
      }, '*');
    });
    return;
  }

  // ===== SESSION DATA QUERY (relay to background) =====
  if (messageType === 'GET_SESSION_DATA') {
    console.log('[Bridge] Querying session data from background');

    chrome.runtime.sendMessage({ type: 'GET_SESSION_DATA' }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[Bridge] Background error:', chrome.runtime.lastError);
        window.postMessage({
          type: 'SESSION_DATA_RESPONSE',
          sessionData: null
        }, '*');
        return;
      }

      console.log('[Bridge] Returning session data, events:', response.sessionData?.events?.length || 0);

      window.postMessage({
        type: 'SESSION_DATA_RESPONSE',
        sessionData: response.sessionData
      }, '*');
    });
    return;
  }
});

console.log('[Bridge] Recording bridge initialized');
