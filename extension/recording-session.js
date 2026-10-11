(() => {
  function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  const MAX_SCREENSHOTS = 5;
  function trimScreenshots(session) {
    const withShots = session.events.reduce((acc, e, i) => {
      if (e.screenshot) acc.push(i);
      return acc;
    }, []);
    if (withShots.length > MAX_SCREENSHOTS) {
      const excess = withShots.length - MAX_SCREENSHOTS;
      for (let i = 0; i < excess; i++) {
        session.events[withShots[i]].screenshot = null;
      }
    }
  }

  function initializeRecordingSession(skillName, skillDetails) {
    const session = {
      sessionId: generateUUID(),
      skillName: skillName || 'Unnamed skill',
      skillDetails: skillDetails || '',
      startTime: Date.now(),
      endTime: null,
      totalDuration: null,
      events: [],
      elementRegistry: {},
      elementCounter: 0,
      metadata: {
        recordingSource: 'browser_extension',
        extensionVersion: '1.0',
        browserInfo: {
          userAgent: navigator.userAgent.slice(0, 200)
        }
      },
      isRecording: false,
    };
    window.recordingSession = session;
    return session;
  }

  function initializeFromBackground(sessionId, skillName, skillDetails, tabId) {
    const session = {
      sessionId: sessionId,
      skillName: skillName || 'Unnamed skill',
      skillDetails: skillDetails || '',
      startTime: Date.now(),
      endTime: null,
      totalDuration: null,
      events: [],
      elementRegistry: {},
      elementCounter: 0,
      isRecording: true,
      tabId: tabId,
      joinedBackground: true
    };
    window.recordingSession = session;
    console.log('[RecordingSession] Joined existing background session:', sessionId);
    return session;
  }

  function startRecording(skillName, skillDetails) {
    const session = window.recordingSession;
    if (!session) throw new Error('No session initialized. Call initializeRecordingSession() first.');
    if (session.isRecording) {
      console.warn('[RecordingSession] Already recording — ignoring duplicate startRecording(). Session:', session.sessionId);
      return session.sessionId;
    }

    // Update skill info if provided
    if (skillName) session.skillName = skillName;
    if (skillDetails) session.skillDetails = skillDetails;

    session.isRecording = true;
    session.startTime = Date.now();
    session.events = [];
    session.elementCounter = 0;
    console.log('[RecordingSession] Recording started. Session:', session.sessionId);
    return session.sessionId;
  }

  function stopRecording() {
    const session = window.recordingSession;
    if (!session) {
      console.warn('[RecordingSession] stopRecording() called with no session.');
      return null;
    }
    if (!session.isRecording) {
      console.warn('[RecordingSession] stopRecording() called while not recording.');
      return validateSessionData({ ...session });
    }
    session.isRecording = false;
    session.endTime = Date.now();
    session.totalDuration = session.endTime - session.startTime;

    // Clean up data before returning
    cleanupEvents(session);

    const sessionData = { ...session };

    sessionData.playwrightMetadata = {
      recordingDuration: sessionData.totalDuration,
      totalEvents: sessionData.events.length,
      eventTypes: {
        navigate: sessionData.events.filter(e => e.type === 'navigate').length,
        click: sessionData.events.filter(e => e.type === 'click').length,
        input: sessionData.events.filter(e => e.type === 'input' || e.type === 'type').length,
        scroll: sessionData.events.filter(e => e.type === 'scroll').length
      },
      elementsUsed: Object.keys(sessionData.elementRegistry).length,
      needsPlaywrightVerification: true,
      playwrightExecutionPriority: 'high'
    };

    console.log('[RecordingSession] Recording stopped.', {
      duration: sessionData.totalDuration + 'ms',
      events: sessionData.events.length,
      elements: Object.keys(sessionData.elementRegistry).length,
      readyForPlaywright: true
    });
    return validateSessionData(sessionData);
  }

  function addEvent(eventData) {
    const session = window.recordingSession;
    if (!session) {
      console.warn('[RecordingSession] addEvent() called with no session.');
      return null;
    }
    if (!session.isRecording) {
      console.warn('[RecordingSession] addEvent() called while not recording.');
      return null;
    }

    // Don't record type events with COMPLETELY empty value (except password fields)
    if (eventData.type === 'type' && !eventData.fieldValue && eventData.elementData?.type !== 'password') {
      console.log('[RecordingSession] Skipped empty type event (non-password)');
      return null;
    }

    // Password events ARE recorded (with empty fieldValue), but still need humanDescription
    if (eventData.type === 'type' && eventData.elementData?.type === 'password' && !eventData.humanDescription) {
      eventData.humanDescription = `Type password in '${eventData.elementData?.label || 'password field'}'`;
    }

    // Resolve element reference, passing enriched elementData when available
    let elementRef = eventData.elementRef || null;
    if (!elementRef && eventData.element) {
      elementRef = captureElement(eventData.element, eventData.elementData);
    }

    const event = {
      type: eventData.type || 'unknown',
      timestamp: eventData.timestamp || Date.now(),
      description: eventData.description || '',
      elementRef,
      ...eventData,
      // Explicit fields so they're always present and not buried in spread
      elementData: eventData.elementData || null,
      pageContext: eventData.pageContext || {
        url: window.location.href,
        title: document.title
      }
    };
    session.events.push(event);
    trimScreenshots(session);
    console.log('[RecordingSession] Event added:', event.type, {
      elementRef,
      selector: eventData.elementData?.selector,
      url: event.url
    });
    return event;
  }

  function validateSelector(selector, element) {
    if (!selector || selector === 'unknown') return false;

    try {
      const found = document.querySelector(selector);

      if (found && found === element) {
        console.log('[RecordingSession] ✓ Selector valid:', selector);
        return true;
      }

      console.warn('[RecordingSession] ⚠ Selector may not work:', selector, '- element mismatch');
      return false;
    } catch (err) {
      console.warn('[RecordingSession] ✗ Selector invalid:', selector, err.message);
      return false;
    }
  }

  function buildFallbackSelector(element) {
    if (element.getAttribute('aria-label')) {
      return `[aria-label="${element.getAttribute('aria-label')}"]`;
    }

    if (element.textContent && element.tagName === 'BUTTON') {
      const text = element.textContent.trim().slice(0, 30);
      return `${element.tagName.toLowerCase()}:contains("${text}")`;
    }

    const role = element.getAttribute('role');
    if (role) {
      return `[role="${role}"]`;
    }

    return null;
  }

  function captureElement(htmlElement, elementData = null) {
    const session = window.recordingSession;
    if (!session) {
      console.warn('[RecordingSession] captureElement() called with no session.');
      return null;
    }
    if (!htmlElement || typeof htmlElement.nodeType === 'undefined') {
      console.warn('[RecordingSession] captureElement() received null/invalid element.');
      return null;
    }
    try {
      session.elementCounter++;
      const ref = 'e' + session.elementCounter;
      const attributes = {};
      if (htmlElement.attributes) {
        for (const attr of htmlElement.attributes) {
          attributes[attr.name] = attr.value;
        }
      }
      const primarySelector = elementData?.selector || buildCSSSelector(htmlElement);
      const selectorValid = validateSelector(primarySelector, htmlElement);
      const finalSelector = selectorValid ? primarySelector : buildFallbackSelector(htmlElement) || primarySelector;

      session.elementRegistry[ref] = {
        // Enriched data from content-script helpers (preferred)
        selector: finalSelector,
        selectorValid,
        primarySelector,
        fallbackUsed: !selectorValid,
        role: elementData?.role || null,
        label: elementData?.label || null,
        coordinates: elementData?.coordinates || null,
        nearbyElements: elementData?.nearbyElements || [],
        pageContext: elementData?.pageContext || null,

        // Fallback raw data
        text: (htmlElement.textContent || '').trim().slice(0, 500),
        type: htmlElement.tagName ? htmlElement.tagName.toLowerCase() : 'unknown',
        html: htmlElement.outerHTML ? htmlElement.outerHTML.slice(0, 2000) : '',
        attributes,

        // Playwright-specific subset
        playwrightData: {
          selector: finalSelector,
          role: elementData?.role || null,
          coordinates: elementData?.coordinates || null,
          isVisible: elementData?.coordinates?.isVisible ?? true
        }
      };
      console.log('[RecordingSession] Element captured:', ref, {
        selector: elementData?.selector,
        role: elementData?.role,
        coordinates: elementData?.coordinates
      });
      return ref;
    } catch (err) {
      console.warn('[RecordingSession] Could not capture element:', err);
      return null;
    }
  }

  function buildCSSSelector(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let segment = current.tagName.toLowerCase();
      if (current.id) {
        segment = '#' + CSS.escape(current.id);
        parts.unshift(segment);
        break;
      }
      const siblings = current.parentNode ? Array.from(current.parentNode.children).filter((c) => c.tagName === current.tagName) : [];
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        segment += ':nth-of-type(' + index + ')';
      }
      parts.unshift(segment);
      current = current.parentNode;
      if (current && current.tagName && current.tagName.toLowerCase() === 'body') {
        parts.unshift('body');
        break;
      }
    }
    return parts.join(' > ');
  }

  function getRecordingSession() {
    return window.recordingSession || null;
  }

  function isCurrentlyRecording() {
    return !!(window.recordingSession && window.recordingSession.isRecording);
  }

  function getElementRegistry() {
    const session = window.recordingSession;
    return session ? { ...session.elementRegistry } : {};
  }

  function cleanupEvents(session) {
    if (!session || !session.events) return;

    const beforeCount = session.events.length;

    // Remove duplicate events (same type, same element, within 100ms)
    const cleaned = [];
    for (let i = 0; i < session.events.length; i++) {
      const current = session.events[i];
      const next = session.events[i + 1];

      // Check if next event is exact duplicate of current
      if (next && current.type === next.type && current.elementRef === next.elementRef) {
        // For type events: also check if fieldValue is identical
        if (current.type === 'type' || current.type === 'input') {
          if (current.fieldValue === next.fieldValue && next.timestamp - current.timestamp < 100) {
            console.log('[RecordingSession] Removing duplicate type event:', current.fieldValue);
            continue; // Skip this duplicate
          }
        }
        // For navigate/click: just check timing
        else if (next.timestamp - current.timestamp < 100) {
          console.log('[RecordingSession] Removing duplicate event:', current.type);
          continue; // Skip this duplicate
        }
      }

      // Merge consecutive type events (rapid typing)
      if (current.type === 'type' && next && next.type === 'type' && current.selector === next.selector) {
        if (next.timestamp - current.timestamp < 300) {
          // Merge into one event with combined value
          const merged = { ...current };
          merged.fieldValue = (current.fieldValue || '') + (next.fieldValue || '');
          merged.humanDescription = "typed '" + merged.fieldValue + "' in " + (current.fieldLabel || 'input field');
          cleaned.push(merged);
          i++; // Skip next event since we merged it
          console.log('[RecordingSession] Merged type events:', merged.fieldValue);
          continue;
        }
      }

      cleaned.push(current);
    }

    session.events = cleaned;
    console.log('[RecordingSession] Cleanup complete. Events reduced from', beforeCount, 'to', cleaned.length);
  }

  function validateSessionData(session) {
    if (!session) return null;

    // Check session has required fields
    if (!session.sessionId) {
      console.warn('[RecordingSession] Session missing sessionId');
      return null;
    }

    // Check events exist
    if (!session.events || session.events.length === 0) {
      console.warn('[RecordingSession] Session has no events');
    }

    // Validate each event
    const validEvents = session.events.filter((event) => {
      if (!event.type) {
        console.warn('[RecordingSession] Event missing type');
        return false;
      }
      if (!event.timestamp) {
        console.warn('[RecordingSession] Event missing timestamp');
        return false;
      }
      if (!event.humanDescription) {
        console.warn('[RecordingSession] Event missing humanDescription');
        return false;
      }
      return true;
    });

    // Validate element registry references
    for (const event of validEvents) {
      if (event.elementRef && !session.elementRegistry[event.elementRef]) {
        console.warn('[RecordingSession] Event references non-existent element:', event.elementRef);
      }
    }

    session.events = validEvents;
    console.log('[RecordingSession] Validation complete. Valid events:', validEvents.length);
    return session;
  }

  function getRecordingData() {
    if (!window.recordingSession) {
      return null;
    }
    return { ...window.recordingSession };
  }

  window.RecordingSession = {
    initializeRecordingSession,
    initializeFromBackground,
    startRecording,
    stopRecording,
    getRecordingData,
    addEvent,
    captureElement,
    getRecordingSession,
    isCurrentlyRecording,
    getElementRegistry,
  };

  initializeRecordingSession();
})();
