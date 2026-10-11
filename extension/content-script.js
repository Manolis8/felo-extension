// ────── HELPER FUNCTIONS FOR BETTER DESCRIPTIONS ──────────────────────

/**
 * Get the associated label text for a form input
 */
function getAssociatedLabel(element) {
  // Check if input has an id with a matching label
  if (element.id) {
    const label = document.querySelector(`label[for="${element.id}"]`);
    if (label) return label.textContent.trim();
  }

  // Check if input is inside a label
  const parentLabel = element.closest('label');
  if (parentLabel) return parentLabel.textContent.trim();

  // Check for aria-label
  if (element.getAttribute('aria-label')) {
    return element.getAttribute('aria-label');
  }

  return null;
}

/**
 * Get placeholder text for an input
 */
function getInputPlaceholder(element) {
  return element.placeholder || element.getAttribute('aria-label') || null;
}

/**
 * Get the current page context (title, main heading, current section)
 */
function getPageContext() {
  // Try to get main heading
  const mainHeading = document.querySelector('h1, [role="heading"][aria-level="1"]');
  if (mainHeading) return mainHeading.textContent.trim().slice(0, 100);

  // Try page title
  const pageTitle = document.title;
  if (pageTitle && pageTitle !== 'localhost' && pageTitle.length < 100) {
    return pageTitle;
  }

  // Try to get current section
  const section = document.querySelector('[role="region"], section, main > div > h2');
  if (section) return section.textContent.trim().slice(0, 100);

  return 'page';
}

/**
 * Get parent form or fieldset context
 */
function getFormContext(element) {
  // Check for closest form with name
  const form = element.closest('form');
  if (form && form.name) return form.name;

  // Check for fieldset legend
  const fieldset = element.closest('fieldset');
  if (fieldset) {
    const legend = fieldset.querySelector('legend');
    if (legend) return legend.textContent.trim();
  }

  // Check for named container
  const container = element.closest('[data-testid], [role="group"]');
  if (container) {
    return container.getAttribute('data-testid') || container.getAttribute('aria-label') || null;
  }

  return null;
}

/**
 * Get descriptive text for a button or clickable element (direct text only)
 */
function getElementDescription(element) {
  let text = '';

  // FIRST: Try aria-label (most reliable for accessibility)
  if (element.getAttribute('aria-label')) {
    return element.getAttribute('aria-label').slice(0, 50);
  }

  // SECOND: Try title attribute
  if (element.title) {
    return element.title.slice(0, 50);
  }

  // THIRD: Get DIRECT text content only (not children)
  // This prevents picking up text from nested elements
  let directText = '';
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      const nodeText = node.textContent?.trim();
      if (nodeText) {
        directText += nodeText + ' ';
      }
    }
  }

  if (directText.trim()) {
    return directText.trim().slice(0, 50);
  }

  // FOURTH: Try icon/SVG with title
  const icon = element.querySelector('svg [title], svg [aria-label]');
  if (icon) {
    text = icon.getAttribute('title') || icon.getAttribute('aria-label');
    if (text) return text.slice(0, 50);
  }

  // LAST: Fallback to all textContent if nothing else works
  text = element.textContent?.trim().slice(0, 50) || '';

  return text || 'element';
}

/**
 * Get URL context - what changed in navigation
 */
function getURLContext(url) {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const search = urlObj.search;

    // Extract meaningful path segments
    const segments = pathname.split('/').filter(s => s.length > 0);
    const lastSegment = segments[segments.length - 1];

    let context = '';
    if (lastSegment === 'new') context = 'creation form';
    else if (lastSegment === 'settings') context = 'settings page';
    else if (lastSegment === 'issues') context = 'issues list';
    else if (lastSegment === 'pulls') context = 'pull requests';
    else if (segments.includes('edit')) context = 'edit page';
    else if (search.includes('search') || search.includes('q=')) context = 'search results';
    else context = lastSegment || 'page';

    return context;
  } catch (err) {
    return 'page';
  }
}

/**
 * Get element role (from role attribute or inferred from tag)
 */
function getElementRole(element) {
  if (element.getAttribute('role')) {
    return element.getAttribute('role');
  }

  const tagRoles = {
    'BUTTON': 'button',
    'A': 'link',
    'INPUT': element.type || 'textbox',
    'TEXTAREA': 'textbox',
    'SELECT': 'combobox',
    'H1': 'heading',
    'H2': 'heading',
    'H3': 'heading',
    'IMG': 'img',
    'FORM': 'form',
    'NAV': 'navigation',
    'MAIN': 'main'
  };

  return tagRoles[element.tagName] || element.tagName.toLowerCase();
}

/**
 * Get all nearby element descriptions (siblings, parent label, etc)
 */
function getNearbyElements(element) {
  const nearby = [];

  const form = element.closest('form');
  if (form && form.getAttribute('aria-label')) {
    nearby.push(`Form: ${form.getAttribute('aria-label')}`);
  }

  const fieldset = element.closest('fieldset');
  if (fieldset) {
    const legend = fieldset.querySelector('legend');
    if (legend) nearby.push(`Fieldset: ${legend.textContent.trim()}`);
  }

  const label = getAssociatedLabel(element);
  if (label && !nearby.includes(`Label: ${label}`)) {
    nearby.push(`Label: ${label}`);
  }

  const parent = element.parentElement;
  if (parent) {
    const siblings = Array.from(parent.children).filter(el => el !== element);
    const nearbyText = siblings
      .map(el => el.textContent?.trim())
      .filter(text => text && text.length < 50 && text.length > 0)
      .slice(0, 3);

    if (nearbyText.length > 0) {
      nearby.push(`Nearby: ${nearbyText.join(', ')}`);
    }
  }

  if (element.getAttribute('aria-describedby')) {
    const descId = element.getAttribute('aria-describedby');
    const descEl = document.getElementById(descId);
    if (descEl) nearby.push(`Help text: ${descEl.textContent.trim()}`);
  }

  return nearby.slice(0, 5);
}

/**
 * Get element coordinates relative to viewport
 */
function getElementCoordinates(element) {
  try {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      centerX: Math.round(rect.left + rect.width / 2),
      centerY: Math.round(rect.top + rect.height / 2),
      isVisible: rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.left >= 0
    };
  } catch (err) {
    return { x: 0, y: 0, isVisible: false };
  }
}

/**
 * Get best CSS selector for element (attempts multiple strategies)
 */
function getBestSelector(element) {
  if (element.id && !element.id.startsWith('__')) {
    return `#${element.id}`;
  }

  if (element.name) {
    return `[name='${element.name}']`;
  }

  if (element.getAttribute('data-testid')) {
    return `[data-testid='${element.getAttribute('data-testid')}']`;
  }

  if (element.className && typeof element.className === 'string') {
    const classes = element.className.split(' ').filter(c => c && !c.startsWith('__'));
    if (classes.length > 0 && classes.length < 5) {
      return `.${classes.join('.')}`;
    }
  }

  if (element.tagName === 'BUTTON') {
    if (element.textContent) {
      return `button:contains("${element.textContent.trim().slice(0, 30)}")`;
    }
    if (element.getAttribute('aria-label')) {
      return `button[aria-label='${element.getAttribute('aria-label')}']`;
    }
  }

  if (element.tagName === 'INPUT') {
    const type = element.type || 'text';
    if (element.placeholder) {
      return `input[type='${type}'][placeholder='${element.placeholder}']`;
    }
    if (element.getAttribute('aria-label')) {
      return `input[aria-label='${element.getAttribute('aria-label')}']`;
    }
  }

  if (element.tagName === 'A') {
    if (element.getAttribute('href')) {
      return `a[href='${element.getAttribute('href')}']`;
    }
  }

  if (element.className && typeof element.className === 'string') {
    const firstClass = element.className.split(' ')[0];
    if (firstClass && !firstClass.startsWith('__')) {
      return `${element.tagName.toLowerCase()}.${firstClass}`;
    }
  }

  return element.tagName.toLowerCase();
}

// ────── END HELPER FUNCTIONS ──────────────────────────────────────────

// Track if a form was just submitted
let lastFormSubmitTime = 0;
const FORM_SUBMIT_WINDOW = 1000; // Consider a submit "recent" for 1 second

function trackFormSubmit(event) {
  if (!window.RecordingSession || !window.RecordingSession.isCurrentlyRecording()) return;

  console.log('[ContentScript] Form submitted:', event.target.id || event.target.name || 'unnamed form');
  lastFormSubmitTime = Date.now();
}

// Listen for actual form submissions
document.addEventListener('submit', trackFormSubmit, true);

// Query background to check if recording is active on this tab
async function queryRecordingState() {
  return new Promise((resolve) => {
    window.postMessage({
      type: 'GET_RECORDING_STATE'
    }, '*');

    // Listen for response from bridge
    const handleStateResponse = (event) => {
      if (event.data?.type === 'RECORDING_STATE_RESPONSE') {
        window.removeEventListener('message', handleStateResponse);
        resolve(event.data.state);
      }
    };

    setTimeout(() => {
      window.removeEventListener('message', handleStateResponse);
      resolve(null);
    }, 2000);

    window.addEventListener('message', handleStateResponse);
  });
}

// Initialize recording if it's already active in background
async function initializeIfRecordingActive() {
  const state = await queryRecordingState();
  if (!state || !state.isRecording) return;

  console.log('[ContentScript] Recording is active. Joining session:', state.sessionId);

  // Initialize local recording session with background state
  if (window.RecordingSession) {
    window.RecordingSession.initializeFromBackground(
      state.sessionId,
      state.skillName,
      state.skillDetails,
      state.tabId
    );
  }
}

// Call on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeIfRecordingActive);
} else {
  initializeIfRecordingActive();
}

// Send message to bridge for multi-tab recording coordination
function sendToRecordingBridge(messageType, eventData, elementRegistry) {
  const message = {
    type: messageType,
    url: window.location.href,
    event: eventData,
    elementRegistry: elementRegistry,
    timestamp: Date.now(),
    tabId: window.__recordingTabId  // Add tab ID to all messages
  };

  window.postMessage(message, '*');
  console.log('[ContentScript] Sent to bridge:', messageType);
}

function getSelector(element) {
  if (element.id) {
    return '#' + CSS.escape(element.id);
  }
  const tag = element.tagName.toLowerCase();
  if (element.className && typeof element.className === 'string') {
    const classes = element.className
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((c) => '.' + CSS.escape(c))
      .join('');
    if (classes) return tag + classes;
  }
  const parent = element.parentElement;
  if (parent) {
    const siblings = Array.from(parent.children);
    const index = siblings.indexOf(element) + 1;
    const parentSelector = getSelector(parent);
    return parentSelector + ' > ' + tag + ':nth-child(' + index + ')';
  }
  return tag;
}

function generateClickDescription(element) {
  const text = (element.innerText || element.textContent || '').trim().replace(/\s+/g, ' ');
  if (text && text.length <= 100) return 'clicked ' + text;
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) return 'clicked ' + ariaLabel;
  const title = element.getAttribute('title');
  if (title) return 'clicked ' + title;
  const tag = element.tagName.toLowerCase();
  if (tag === 'button' || element.getAttribute('role') === 'button') return 'clicked button';
  if (tag === 'a') return 'clicked link';
  if (tag === 'input') {
    const type = (element.getAttribute('type') || 'text').toLowerCase();
    return 'clicked ' + type + ' input';
  }
  return 'clicked element';
}

function handleClick(event) {
  // Don't record clicks on Recording UI buttons
  const buttonText = event.target.textContent?.trim() || '';
  const blockedButtons = ['Stop & Review', 'Finish', '⏹', '✓', 'Pause', 'Resume'];

  if (blockedButtons.some(btn => buttonText.includes(btn))) {
    console.log('[ContentScript] ✓ Skipped click on Recording UI button:', buttonText);
    return;
  }

  if (!window.RecordingSession || !window.RecordingSession.isCurrentlyRecording()) return;

  try {
    const element = event.target;
    if (!element) return;

    // BUILD ENRICHED DATA FIRST (before calling captureElement)
    const selector = getBestSelector(element);
    const role = getElementRole(element);
    const coordinates = getElementCoordinates(element);
    const nearbyElements = getNearbyElements(element);
    const pageTitle = document.title;
    const formContext = getFormContext(element);

    const elementData = {
      selector,
      role,
      label: getAssociatedLabel(element) || getInputPlaceholder(element) || getElementDescription(element),
      text: (element.innerText || element.textContent || '').trim().slice(0, 500),
      type: element.tagName.toLowerCase(),
      coordinates,
      nearbyElements,
      pageContext: {
        url: window.location.href,
        title: pageTitle,
        formName: formContext || null
      }
    };

    // NOW capture element WITH enriched data
    const elementRef = window.RecordingSession.captureElement(element, elementData);

    // Build description
    const elementDesc = getElementDescription(element);
    const isButton = element.tagName === 'BUTTON' || element.classList.contains('btn') || element.role === 'button';
    const isLink = element.tagName === 'A';
    const isInput = element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT';
    const pageContext = getPageContext();

    let fullDescription = '';

    if (isButton) {
      fullDescription = `Click '${elementDesc}' button`;
      if (formContext) fullDescription += ` in ${formContext}`;
      fullDescription += ` (${pageContext})`;
    } else if (isLink) {
      const href = element.getAttribute('href') || '';
      fullDescription = `Click '${elementDesc}' link`;
      if (href) fullDescription += ` (${href})`;
    } else if (isInput) {
      const label = getAssociatedLabel(element);
      const placeholder = getInputPlaceholder(element);
      const fieldName = label || placeholder || element.id || 'input field';
      fullDescription = `Click on '${fieldName}' input field to focus`;
      if (formContext) fullDescription += ` (in ${formContext})`;
    } else if (element.tagName === 'CHECKBOX' || element.tagName === 'RADIO') {
      const label = getAssociatedLabel(element);
      const checked = element.checked ? 'Check' : 'Uncheck';
      fullDescription = `${checked} '${label || elementDesc}' checkbox`;
    } else if (element.tagName === 'SELECT') {
      const label = getAssociatedLabel(element);
      fullDescription = `Click on '${label || elementDesc}' dropdown menu`;
    } else {
      fullDescription = `Click on ${elementDesc} (${pageContext})`;
    }

    const eventObj = {
      type: 'click',
      timestamp: Date.now(),
      url: window.location.href,
      elementRef,
      selector: getBestSelector(element),
      elementText: (element.innerText || element.textContent || '').trim().slice(0, 500),
      elementType: element.tagName.toLowerCase(),
      x: event.clientX,
      y: event.clientY,
      humanDescription: fullDescription,
      screenshot: null,
      elementData  // ✅ NOW has full data
    };

    window.RecordingSession.addEvent(eventObj);
    sendToRecordingBridge('RECORD_EVENT', eventObj, window.RecordingSession.getElementRegistry());
    console.log('[ContentScript] Click captured:', fullDescription);
  } catch (err) {
    console.warn('[ContentScript] Could not capture click:', err);
  }
}

function getFieldLabel(inputElement) {
  if (inputElement.id) {
    const label = document.querySelector('label[for="' + CSS.escape(inputElement.id) + '"]');
    if (label) return (label.innerText || label.textContent || '').trim();
  }
  const wrappingLabel = inputElement.closest('label');
  if (wrappingLabel) {
    const clone = wrappingLabel.cloneNode(true);
    clone.querySelectorAll('input, textarea, select').forEach((el) => el.remove());
    const text = (clone.innerText || clone.textContent || '').trim();
    if (text) return text;
  }
  const placeholder = inputElement.getAttribute('placeholder');
  if (placeholder) return placeholder;
  const ariaLabel = inputElement.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel;
  const ariaLabelledBy = inputElement.getAttribute('aria-labelledby');
  if (ariaLabelledBy) {
    const labelEl = document.getElementById(ariaLabelledBy);
    if (labelEl) return (labelEl.innerText || labelEl.textContent || '').trim();
  }
  const title = inputElement.getAttribute('title');
  if (title) return title;
  return 'input field';
}

function generateTypeDescription(element) {
  const label = getFieldLabel(element);
  const value = (element.value || element.textContent || '').trim();
  if (value.length > 0 && value.length < 50) {
    return "typed '" + value + "' in " + label;
  }
  return 'typed text in ' + label;
}

function isTypableElement(element) {
  const tag = element.tagName.toLowerCase();
  if (tag === 'input') {
    const type = (element.getAttribute('type') || 'text').toLowerCase();
    return !['checkbox', 'radio', 'submit', 'reset', 'button', 'image', 'file', 'range', 'color'].includes(type);
  }
  if (tag === 'textarea') return true;
  if (element.getAttribute('contenteditable') === 'true' || element.getAttribute('contenteditable') === '') return true;
  return false;
}

function handleInputEvent(event) {
  if (!window.RecordingSession || !window.RecordingSession.isCurrentlyRecording()) return;

  try {
    const element = event.target;
    if (!element || !isTypableElement(element)) return;

    // BUILD ENRICHED DATA FIRST (before calling captureElement)
    const selector = getBestSelector(element);
    const role = getElementRole(element);
    const coordinates = getElementCoordinates(element);
    const nearbyElements = getNearbyElements(element);
    const pageTitle = document.title;
    const isPassword = element.type === 'password';
    const label = getAssociatedLabel(element);
    const placeholder = getInputPlaceholder(element);
    const fieldName = label || placeholder || element.id || element.name || 'field';
    const formContext = getFormContext(element);

    const elementData = {
      selector,
      role,
      label: fieldName,
      type: element.type || 'text',
      coordinates,
      nearbyElements,
      pageContext: {
        url: window.location.href,
        title: pageTitle,
        formName: formContext || null
      }
    };

    // NOW capture element WITH enriched data
    const elementRef = window.RecordingSession.captureElement(element, elementData);

    // Build description
    const currentValue = (element.value || element.textContent || '').trim().slice(-30);
    const isEmail = element.type === 'email';
    const isNumber = element.type === 'number';
    const isSearch = element.type === 'search';

    let fieldType = '';
    if (isPassword) fieldType = 'password';
    else if (isEmail) fieldType = 'email address';
    else if (isNumber) fieldType = 'number';
    else if (isSearch) fieldType = 'search query';
    else if (element.tagName === 'TEXTAREA') fieldType = 'text area';
    else fieldType = 'text';

    let fullDescription = '';

    if (isPassword) {
      fullDescription = `Type password in the '${fieldName}' password field`;
    } else if (isEmail) {
      fullDescription = `Type '${currentValue}' in the '${fieldName}' email address field`;
    } else if (isSearch) {
      fullDescription = `Type '${currentValue}' in the '${fieldName}' search field`;
    } else {
      const displayValue = currentValue.length > 50 ? currentValue.slice(0, 47) + '...' : currentValue;
      fullDescription = `Type '${displayValue}' in the '${fieldName}' ${fieldType}`;
    }

    if (formContext) fullDescription += ` (in ${formContext})`;

    const eventObj = {
      type: 'type',
      timestamp: Date.now(),
      url: window.location.href,
      elementRef,
      selector: getBestSelector(element),
      fieldName: element.name || element.id || 'unknown',
      fieldLabel: fieldName,
      fieldValue: isPassword ? '' : (element.value || element.textContent || '').trim(),
      humanDescription: fullDescription,
      screenshot: null,
      elementData  // ✅ NOW has full data
    };

    window.RecordingSession.addEvent(eventObj);
    sendToRecordingBridge('RECORD_EVENT', eventObj, window.RecordingSession.getElementRegistry());
    console.log('[ContentScript] Type captured:', fullDescription);
  } catch (err) {
    console.warn('[ContentScript] Could not capture input:', err);
  }
}

function generateNavigateDescription(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const path = parsed.pathname.replace(/\/$/, '');
    if (path && path !== '') {
      return 'navigated to ' + host + path;
    }
    return 'navigated to ' + host;
  } catch (_) {
    return 'navigated to ' + url;
  }
}

function captureNavigationEvent(url) {
  if (!window.RecordingSession || !window.RecordingSession.isCurrentlyRecording()) return;

  try {
    const newURL = url || window.location.href;
    let newPathname = '';
    let newSearch = '';
    try {
      const parsed = new URL(newURL);
      newPathname = parsed.pathname;
      newSearch = parsed.search;
    } catch (_) {}
    const pageTitle = document.title;
    const urlContext = getURLContext(newURL);

    // Extract useful query params
    let queryInfo = '';
    if (newSearch) {
      const params = new URLSearchParams(newSearch);
      const values = Array.from(params.values()).slice(0, 2);
      if (values.length > 0 && Array.from(params.keys()).length <= 3) {
        queryInfo = ` (searching for: ${values.join(', ')})`;
      }
    }

    // Detect what caused the navigation
    let trigger = 'navigated to';

    // Check if a form was just submitted (within the last second)
    const timeSinceSubmit = Date.now() - lastFormSubmitTime;
    if (timeSinceSubmit < FORM_SUBMIT_WINDOW) {
      trigger = 'submitted form and navigated to';
      lastFormSubmitTime = 0; // Reset so we don't use it again
    }
    // Check if this is a search query in the URL
    else if (newSearch.includes('q=') || newSearch.includes('search=')) {
      trigger = 'performed search and navigated to';
    }

    let fullDescription = '';

    if (urlContext === 'creation form') {
      fullDescription = `${trigger} create new item form (${pageTitle})`;
    } else if (urlContext === 'settings page') {
      fullDescription = `${trigger} settings page (${pageTitle})`;
    } else if (urlContext === 'edit page') {
      fullDescription = `${trigger} edit page (${pageTitle})`;
    } else if (urlContext === 'search results') {
      fullDescription = `${trigger} search results page${queryInfo}`;
    } else if (newPathname === '/' || newPathname === '') {
      fullDescription = `${trigger} home page (${pageTitle})`;
    } else {
      fullDescription = `${trigger} ${urlContext} (${pageTitle})`;
    }

    fullDescription += ` → ${newURL}`;

    const eventObj = {
      type: 'navigate',
      timestamp: Date.now(),
      url: newURL,
      humanDescription: fullDescription,
      screenshot: null,
      elementRef: null,
      pageContext: {
        fromURL: window.location.href,
        toURL: newURL,
        pageTitle: document.title,
        pageType: urlContext
      }
    };

    window.RecordingSession.addEvent(eventObj);
    sendToRecordingBridge('RECORD_EVENT', eventObj, window.RecordingSession.getElementRegistry());
    console.log('[ContentScript] Navigate captured:', fullDescription);
  } catch (err) {
    console.warn('[ContentScript] Could not capture navigation:', err);
  }
}

(function patchHistory() {
  const _pushState = history.pushState.bind(history);
  const _replaceState = history.replaceState.bind(history);

  history.pushState = function (state, title, url) {
    _pushState(state, title, url);
    captureNavigationEvent(window.location.href);
  };

  history.replaceState = function (state, title, url) {
    _replaceState(state, title, url);
    captureNavigationEvent(window.location.href);
  };
})();

function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

function generateScrollDescription(direction, amount) {
  return 'scrolled ' + direction + ' by ' + amount + 'px';
}

function setupScrollListener() {
  let scrollStartY = window.scrollY;

  const commitScroll = debounce(() => {
    if (!window.RecordingSession || !window.RecordingSession.isCurrentlyRecording()) return;

    try {
      const currentY = window.scrollY;
      const delta = currentY - scrollStartY;

      if (Math.abs(delta) < 100) {
        scrollStartY = currentY;
        return;
      }

      const direction = delta > 0 ? 'down' : 'up';
      const amount = Math.abs(delta);
      const description = generateScrollDescription(direction, amount);

      const eventObj = {
        type: 'scroll',
        timestamp: Date.now(),
        elementRef: null,
        direction,
        amount,
        scrollY: currentY,
        humanDescription: description,
        screenshot: null,
      };

      // Add URL to event before storing
      eventObj.url = window.location.href;

      window.RecordingSession.addEvent(eventObj);
      sendToRecordingBridge('RECORD_EVENT', eventObj, window.RecordingSession.getElementRegistry());
      console.log('[ContentScript] Scroll captured:', direction, amount + 'px');

      scrollStartY = currentY;
    } catch (err) {
      console.warn('[ContentScript] Could not capture scroll:', err);
    }
  }, 500);

  window.addEventListener('scroll', commitScroll, { passive: true });
}

function initializeContentScript() {
  if (!window.RecordingSession) {
    console.error('[ContentScript] window.RecordingSession not found. Listeners not attached.');
    return;
  }

  const session = window.RecordingSession.initializeRecordingSession();
  window.currentRecordingSession = session;

  document.addEventListener('click', handleClick, true);
  // Debounce input so typing "manolis" = 1 event, not 7
  const debouncedInputHandler = debounce(handleInputEvent, 500);
  document.addEventListener('input', debouncedInputHandler, true);
  // NOTE: Removed 'change' listener to avoid duplicate type events

  window.addEventListener('popstate', () => captureNavigationEvent(window.location.href));
  window.addEventListener('load', () => captureNavigationEvent(window.location.href));

  setupScrollListener();

  console.log('[ContentScript] Recording infrastructure initialized. Session:', session.sessionId);

  // Report to background that content script loaded successfully on this URL
  window.postMessage({
    type: 'CONTENT_SCRIPT_READY',
    url: window.location.href,
    hostname: new URL(window.location.href).hostname
  }, '*');

  window.startRecording = function (skillName, skillDetails) {
    const sessionId = window.RecordingSession.startRecording(skillName, skillDetails);

    // Also notify background for multi-tab coordination
    window.postMessage({
      type: 'START_RECORDING',
      skillName: skillName,
      skillDetails: skillDetails,
      url: window.location.href
    }, '*');

    console.log('%c[Recording] Started. SessionId: ' + sessionId, 'color: #22c55e; font-weight: bold;');
    return sessionId;
  };

  window.stopRecording = function () {
    // Stop local recording
    const localData = window.RecordingSession.stopRecording();

    // Notify background to stop (merged data lives there)
    window.postMessage({
      type: 'STOP_RECORDING'
    }, '*');

    // Return local data with sessionId
    // (Full merged data is in background coordinator - backend will get it)
    console.log('%c[Recording] Stopped. Events: ' + (localData?.events?.length || 0), 'color: #ef4444; font-weight: bold;');
    console.log('[Recording] SessionId:', localData?.sessionId, '(Full merged data stored in background)');

    // Async cleanup of background session (fire and forget)
    setTimeout(() => {
      window.postMessage({ type: 'CLEAR_SESSION' }, '*');
    }, 100);

    return localData;
  };

  window.getRecordingData = function () {
    const data = window.RecordingSession.getRecordingSession();
    console.log('[Recording] Current session (' + (data.isRecording ? 'RECORDING' : 'stopped') + '):');
    console.log('  Events:', data.events.length);
    console.log('  Elements:', Object.keys(data.elementRegistry).length);
    return data;
  };

  window.clearRecording = function () {
    const newSession = window.RecordingSession.initializeRecordingSession();
    window.currentRecordingSession = newSession;
    console.log('%c[Recording] Cleared. Fresh session: ' + newSession.sessionId, 'color: #60a5fa; font-weight: bold;');
    return newSession.sessionId;
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeContentScript, { once: true });
} else {
  initializeContentScript();
}
