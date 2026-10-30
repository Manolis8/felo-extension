import { buildUnclawnedWsUrl, isRetryableReconnectError, reconnectDelayMs } from './background-utils.js'

// Default: the Unclawned CLI. MCP bridge mode uses ws://localhost:3011 (set it in Options).
const SERVER_URL = 'ws://localhost:3001'
const MCP_BRIDGE_URL = 'ws://localhost:3011'
const TOKEN_PREFIX = 'felo_'
const TOKEN_MIN_LENGTH = 10 // felo_ prefix (4) + minimum characters (6)

const BADGE = {
  on: { text: 'ON', color: '#FF5A36' },
  off: { text: '', color: '#000000' },
  connecting: { text: '…', color: '#F59E0B' },
  error: { text: '!', color: '#B91C1C' },
}

/** @type {WebSocket|null} */
let relayWs = null
/** @type {Promise<void>|null} */
let relayConnectPromise = null
let relayUserToken = ''
/** @type {string|null} */
let relayConnectRequestId = null

let nextSession = 1

/** @type {Map<number, {state:'connecting'|'connected', sessionId?:string, targetId?:string, attachOrder?:number}>} */
const tabs = new Map()
/** @type {Map<string, number>} */
const tabBySession = new Map()
/** @type {Map<string, number>} */
const childSessionToTab = new Map()

/** @type {Map<number, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
const pending = new Map()

// Per-tab operation locks prevent double-attach races.
/** @type {Set<number>} */
const tabOperationLocks = new Set()

// Tabs currently in a detach/re-attach cycle after navigation.
/** @type {Set<number>} */
const reattachPending = new Set()

// Reconnect state for exponential backoff.
let reconnectAttempt = 0
/** Last connection error, shown in the popup. */
let lastRelayError = ''
let reconnectTimer = null

function nowStack() {
  try {
    return new Error().stack || ''
  } catch {
    return ''
  }
}

async function getConnectionSettings() {
  const stored = await chrome.storage.local.get(['serverUrl', 'userToken'])
  const serverUrl = String(stored.serverUrl || SERVER_URL).trim()
  let userToken = String(stored.userToken || '').trim()
  if (!isValidToken(userToken)) {
    const isLocalhost = serverUrl.includes('localhost') || serverUrl.includes('127.0.0.1')
    if (isLocalhost) {
      userToken = 'felo_local_dev'
    } else {
      throw new Error('Invalid token: must start with felo_ and be at least 10 characters')
    }
  }
  return { serverUrl, userToken }
}

function isValidToken(token) {
  return typeof token === 'string' && token.startsWith(TOKEN_PREFIX) && token.length >= TOKEN_MIN_LENGTH
}

function setBadge(tabId, kind) {
  const cfg = BADGE[kind]
  void chrome.action.setBadgeText({ tabId, text: cfg.text })
  void chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color })
  void chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' }).catch(() => {})
}

// Persist attached tab state to survive MV3 service worker restarts.
async function persistState() {
  try {
    const tabEntries = []
    for (const [tabId, tab] of tabs.entries()) {
      if (tab.state === 'connected' && tab.sessionId && tab.targetId) {
        tabEntries.push({ tabId, sessionId: tab.sessionId, targetId: tab.targetId, attachOrder: tab.attachOrder })
      }
    }
    await chrome.storage.session.set({
      persistedTabs: tabEntries,
      nextSession,
    })
  } catch {
    // chrome.storage.session may not be available in all contexts.
  }
}

// Rehydrate tab state on service worker startup. Fast path — just restores
// maps and badges. Relay reconnect happens separately in background.
async function rehydrateState() {
  try {
    const stored = await chrome.storage.session.get(['persistedTabs', 'nextSession'])
    if (stored.nextSession) {
      nextSession = Math.max(nextSession, stored.nextSession)
    }
    const entries = stored.persistedTabs || []
    // Phase 1: optimistically restore state and badges.
    for (const entry of entries) {
      tabs.set(entry.tabId, {
        state: 'connected',
        sessionId: entry.sessionId,
        targetId: entry.targetId,
        attachOrder: entry.attachOrder,
      })
      tabBySession.set(entry.sessionId, entry.tabId)
      setBadge(entry.tabId, 'on')
    }
    // Phase 2: validate asynchronously, remove dead tabs.
    for (const entry of entries) {
      try {
        await chrome.tabs.get(entry.tabId)
        await chrome.debugger.sendCommand({ tabId: entry.tabId }, 'Runtime.evaluate', {
          expression: '1',
          returnByValue: true,
        })
      } catch {
        tabs.delete(entry.tabId)
        tabBySession.delete(entry.sessionId)
        setBadge(entry.tabId, 'off')
      }
    }
  } catch {
    // Ignore rehydration errors.
  }
}

/** Address the relay actually connected to (may differ from the saved one). */
let activeServerUrl = ''

function toHttpBase(serverUrl) {
  return serverUrl
    .replace('wss://', 'https://')
    .replace('ws://', 'http://')
    .split('/extension')[0]
}

async function findReachableServer(savedUrl) {
  const isLocal = savedUrl.includes('localhost') || savedUrl.includes('127.0.0.1')
  const candidates = [savedUrl]
  if (isLocal) {
    for (const url of [SERVER_URL, MCP_BRIDGE_URL]) {
      if (!candidates.includes(url)) candidates.push(url)
    }
  }
  let lastErr = null
  for (const url of candidates) {
    try {
      await fetch(`${toHttpBase(url)}/health`, { method: 'GET', signal: AbortSignal.timeout(3000) })
      if (url !== savedUrl) console.log(`Saved address ${savedUrl} not reachable, using ${url}`)
      return url
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(`Unclawned server not reachable at ${candidates.join(' or ')} (${String(lastErr)})`)
}

async function ensureRelayConnection() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return
  if (relayConnectPromise) return await relayConnectPromise

  relayConnectPromise = (async () => {
    const settings = await getConnectionSettings()
    const { userToken } = settings
    // Fast preflight: is the Unclawned server up? Try the saved address first,
    // then the other local default (CLI 3001 / MCP bridge 3011), so a saved
    // port that doesn't match the running mode still connects.
    const serverUrl = await findReachableServer(settings.serverUrl)
    activeServerUrl = serverUrl
    const wsUrl = buildUnclawnedWsUrl(serverUrl, userToken)

    const ws = new WebSocket(wsUrl)
    relayWs = ws
    relayUserToken = userToken
    // Bind message handler before open so an immediate first frame (for example
    // gateway connect.challenge) cannot be missed.
    ws.onmessage = (event) => {
      if (ws !== relayWs) return
      void whenReady(() => onRelayMessage(String(event.data || '')))
    }

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket connect timeout')), 5000)
      ws.onopen = () => {
        clearTimeout(t)
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(t)
        reject(new Error('WebSocket connect failed'))
      }
      ws.onclose = (ev) => {
        clearTimeout(t)
        reject(new Error(`WebSocket closed (${ev.code} ${ev.reason || 'no reason'})`))
      }
    })

    // Bind permanent handlers. Guard against stale socket: if this WS was
    // replaced before its close fires, the handler is a no-op.
    ws.onclose = (event) => {
      if (ws !== relayWs) return
      // Close code 1001 = server intentionally shutting down — detach all debugger sessions
      if (event.code === 1001) {
        const tabIds = [...tabs.keys()]
        tabs.clear()
        tabBySession.clear()
        childSessionToTab.clear()
        cancelReconnect()
        relayWs = null
        relayUserToken = ''
        relayConnectRequestId = null
        for (const [, p] of pending.entries()) p.reject(new Error('Server shut down'))
        pending.clear()
        for (const tabId of tabIds) {
          chrome.debugger.detach({ tabId }).catch(() => {})
          setBadge(tabId, 'off')
          void chrome.action.setTitle({ tabId, title: 'Unclawned' })
        }
        return
      }
      onRelayClosed('closed')
    }
    ws.onerror = () => {
      if (ws !== relayWs) return
      onRelayClosed('error')
    }
  })()

  try {
    await relayConnectPromise
    reconnectAttempt = 0
  } finally {
    relayConnectPromise = null
  }
}

// Relay closed — update badges, reject pending requests, auto-reconnect.
// Debugger sessions are kept alive so they survive transient WS drops.
function onRelayClosed(reason) {
  relayWs = null
  relayUserToken = ''
  relayConnectRequestId = null

  for (const [id, p] of pending.entries()) {
    pending.delete(id)
    p.reject(new Error(`Relay disconnected (${reason})`))
  }

  reattachPending.clear()

  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state === 'connected') {
      setBadge(tabId, 'connecting')
      void chrome.action.setTitle({
        tabId,
        title: 'Felo Browser Agent: relay reconnecting…',
      })
    }
  }

  scheduleReconnect()
}

function scheduleReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  const delay = reconnectDelayMs(reconnectAttempt)
  reconnectAttempt++

  console.log(`Scheduling reconnect attempt ${reconnectAttempt} in ${Math.round(delay)}ms`)

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null
    try {
      await ensureRelayConnection()
      reconnectAttempt = 0
      lastRelayError = ''
      console.log('Reconnected successfully')
      await reannounceAttachedTabs()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      lastRelayError = message
      console.warn(`Reconnect attempt ${reconnectAttempt} failed: ${message}`)
      if (!isRetryableReconnectError(err)) {
        return
      }
      scheduleReconnect()
    }
  }, delay)
}

function cancelReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempt = 0
}

// Re-announce all attached tabs to the relay after reconnect.
async function reannounceAttachedTabs() {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state !== 'connected' || !tab.sessionId || !tab.targetId) continue

    // Verify debugger is still attached.
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: '1',
        returnByValue: true,
      })
    } catch {
      tabs.delete(tabId)
      if (tab.sessionId) tabBySession.delete(tab.sessionId)
      setBadge(tabId, 'off')
      void chrome.action.setTitle({
        tabId,
        title: 'Unclawned (click to attach/detach)',
      })
      continue
    }

    // Send fresh attach event to relay.
    // Split into two try-catch blocks so debugger failures and relay send
    // failures are handled independently. Previously, a relay send failure
    // would fall into the outer catch and set the badge to 'on' even though
    // the relay had no record of the tab — causing every subsequent browser
    // tool call to fail with "no tab connected" until the next reconnect cycle.
    let targetInfo
    try {
      const info = /** @type {any} */ (
        await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo')
      )
      targetInfo = info?.targetInfo
    } catch {
      // Target.getTargetInfo failed. Preserve at least targetId from
      // cached tab state so relay receives a stable identifier.
      targetInfo = tab.targetId ? { targetId: tab.targetId } : undefined
    }

    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.attachedToTarget',
          params: {
            sessionId: tab.sessionId,
            targetInfo: { ...targetInfo, attached: true },
            waitingForDebugger: false,
          },
        },
      })

      setBadge(tabId, 'on')
      void chrome.action.setTitle({
        tabId,
        title: 'Unclawned: relay reconnecting…',
      })
    } catch {
      // Relay send failed (e.g. WS closed in the gap between ensureRelayConnection
      // resolving and this loop executing). The tab is still valid — leave badge
      // as 'connecting' so the reconnect/keepalive cycle will retry rather than
      // showing a false-positive 'on' that hides the broken state from the user.
      setBadge(tabId, 'connecting')
      void chrome.action.setTitle({
        tabId,
        title: 'Felo Browser Agent: relay reconnecting…',
      })
    }
  }

  await persistState()
}

function sendToRelay(payload) {
  const ws = relayWs
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('Relay not connected')
  }
  ws.send(JSON.stringify(payload))
}

async function maybeOpenHelpOnce() {
  try {
    const stored = await chrome.storage.local.get(['helpOnErrorShown'])
    if (stored.helpOnErrorShown === true) return
    await chrome.storage.local.set({ helpOnErrorShown: true })
    await chrome.runtime.openOptionsPage()
  } catch {
    // ignore
  }
}

function requestFromRelay(command) {
  const id = command.id
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Relay request timeout (30s)'))
    }, 30000)
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v) },
      reject: (e) => { clearTimeout(timer); reject(e) },
    })
    try {
      sendToRelay(command)
    } catch (err) {
      clearTimeout(timer)
      pending.delete(id)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

async function onRelayMessage(text) {
  /** @type {any} */
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    return
  }

  // The action has a popup, so chrome.action.onClicked never fires. Once the
  // server confirms that its internal CDP bridge is ready, attach the active
  // web tab automatically when there is no existing attached tab.
  if (msg && msg.method === 'connected') {
    await attachActiveTabIfNeeded()
    return
  }

  if (msg && msg.method === 'ping') {
    try {
      sendToRelay({ method: 'pong' })
    } catch {
      // ignore
    }
    return
  }

  if (msg && typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(String(msg.error)))
    else p.resolve(msg.result)
    return
  }

  if (msg && msg.method === 'createAndAttachTab') {
    const id = msg.id
    try {
      const url = msg.params?.url || 'about:blank'
      const tab = await chrome.tabs.create({ url, active: false })
      await new Promise(r => setTimeout(r, 500))
      await ensureRelayConnection()
      const attached = await attachTab(tab.id)
      sendToRelay({ id, result: { tabId: tab.id, ...attached } })
    } catch (err) {
      sendToRelay({ id, error: err instanceof Error ? err.message : String(err) })
    }
    return
  }

  if (msg && msg.method === 'closeTab') {
    const id = msg.id
    try {
      const tabId = msg.params?.tabId
      if (tabId) await chrome.tabs.remove(tabId)
      sendToRelay({ id, result: { ok: true } })
    } catch (err) {
      sendToRelay({ id, error: err instanceof Error ? err.message : String(err) })
    }
    return
  }

  if (msg && msg.method === 'detachTab') {
    const id = msg.id
    try {
      const tabId = msg.params?.tabId
      if (tabId) {
        // Detach the debugger (removes the banner)
        await chrome.debugger.detach({ tabId })
        // Tab stays open
      }
      sendToRelay({ id, result: { ok: true } })
    } catch (err) {
      sendToRelay({ id, error: err instanceof Error ? err.message : String(err) })
    }
    return
  }

  if (msg && msg.method === 'detachAllTabs') {
    const id = msg.id
    try {
      const detachPromises = []
      for (const [tabId] of tabs.entries()) {
        detachPromises.push(chrome.debugger.detach({ tabId }).catch(() => {}))
      }
      await Promise.all(detachPromises)
      tabs.clear()
      tabBySession.clear()
      try { sendToRelay({ id, result: { ok: true } }) } catch {}
    } catch (err) {
      try { sendToRelay({ id, error: err instanceof Error ? err.message : String(err) }) } catch {}
    }
    return
  }

  if (msg && typeof msg.id === 'number' && msg.method === 'getTabs') {
    const id = msg.id
    try {
      const SKIP = /^(chrome|edge|about|chrome-extension|devtools):\/\//i
      const SENSITIVE = /\b(bank|paypal|venmo|wallet|accounts\.google\.com|login\.apple\.com|signin\.|password)\b/i
      const allChromeTabs = await chrome.tabs.query({})
      const result = allChromeTabs
        .filter(t => t.url && !SKIP.test(t.url) && t.id != null)
        .map(t => {
          const isSensitive = SENSITIVE.test(t.url || '') || SENSITIVE.test(t.title || '')
          return {
            tabId: t.id,
            url: isSensitive ? '[sensitive]' : (t.url || ''),
            title: isSensitive ? '[private tab]' : (t.title || ''),
            active: !!t.active,
            windowId: t.windowId,
            isAttached: tabs.has(t.id),
            isSensitive,
          }
        })
        .sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0))
      sendToRelay({ id, result: { tabs: result } })
    } catch (err) {
      sendToRelay({ id, error: err instanceof Error ? err.message : String(err) })
    }
    return
  }

  if (msg && typeof msg.id === 'number' && msg.method === 'switchToTab') {
    const id = msg.id
    try {
      const tabId = msg.params?.tabId
      if (!tabId) throw new Error('tabId is required')

      // Verify the target tab still exists
      const targetTab = await chrome.tabs.get(tabId).catch(() => null)
      if (!targetTab) throw new Error(`Tab ${tabId} no longer exists — it may have been closed`)

      // Detach debugger from all other tabs (removes their debugging banner)
      const others = [...tabs.keys()].filter(id => id !== tabId)
      await Promise.all(others.map(otherId => detachTab(otherId, 'tab_switch').catch(() => {})))

      // Make the target tab active and visible in Chrome
      await chrome.tabs.update(tabId, { active: true })
      const win = await chrome.windows.get(targetTab.windowId).catch(() => null)
      if (win && !win.focused) {
        await chrome.windows.update(targetTab.windowId, { focused: true }).catch(() => {})
      }
      await new Promise(r => setTimeout(r, 350))

      // If already attached, return existing session info
      if (tabs.has(tabId)) {
        const existing = tabs.get(tabId)
        sendToRelay({ id, result: { tabId, sessionId: existing.sessionId, targetId: existing.targetId, alreadyAttached: true } })
        return
      }

      // Attach debugger and announce to Playwright via CDP events
      await ensureRelayConnection()
      const attached = await attachTab(tabId)
      sendToRelay({ id, result: { tabId, sessionId: attached.sessionId, targetId: attached.targetId, alreadyAttached: false } })
    } catch (err) {
      sendToRelay({ id, error: err instanceof Error ? err.message : String(err) })
    }
    return
  }

  if (msg && typeof msg.id === 'number' && msg.method === 'forwardCDPCommand') {
    try {
      const result = await handleForwardCdpCommand(msg)
      sendToRelay({ id: msg.id, result })
    } catch (err) {
      sendToRelay({ id: msg.id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  if (msg && typeof msg.id === 'number' && msg.method === 'executeDebugger') {
    const id = msg.id
    try {
      const { tabId, selector, text } = msg.params || {}
      if (!tabId || !text) {
        sendToRelay({ id, error: 'tabId and text required' })
        return
      }

      const inputSelector = selector || 'input[name="verification_field"]'

      // Get element position for real mouse click
      const posResult = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: `
          (function() {
            const el = document.querySelector('${inputSelector}');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width/2, y: r.top + r.height/2, found: true };
          })()
        `,
        returnByValue: true
      })

      const pos = posResult?.result?.value
      if (!pos?.found) throw new Error('Input element not found on page')

      // Real mouse click at element coordinates
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
        type: 'mousePressed', x: pos.x, y: pos.y,
        button: 'left', clickCount: 1
      })
      await new Promise(r => setTimeout(r, 50))
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: pos.x, y: pos.y,
        button: 'left', clickCount: 1
      })
      await new Promise(r => setTimeout(r, 200))

      // Type each character as real keystroke
      for (const char of text) {
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
          type: 'keyDown', key: char, text: char
        })
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
          type: 'keyUp', key: char, text: char
        })
        await new Promise(r => setTimeout(r, 30))
      }

      await new Promise(r => setTimeout(r, 500))

      // Click submit button
      const clickResult = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: `
          (function() {
            const btn = document.querySelector('[data-test-selector="repo-delete-proceed-button"]');
            if (btn && !btn.disabled) { btn.click(); return 'clicked'; }
            return 'button disabled or not found: ' + (btn ? 'disabled='+btn.disabled : 'null');
          })()
        `,
        returnByValue: true
      })

      sendToRelay({ id, result: { ok: true, typed: text, clickResult } })
    } catch (err) {
      sendToRelay({ id, error: err instanceof Error ? err.message : String(err) })
    }
    return
  }

  if (msg && typeof msg.id === 'number' && msg.method === 'getTabIdForTarget') {
    const { targetId } = msg.params || {}
    let foundTabId = null
    for (const [tabId, tab] of tabs.entries()) {
      if (tab.targetId === targetId) {
        foundTabId = tabId
        break
      }
    }
    sendToRelay({ id: msg.id, result: { tabId: foundTabId } })
    return
  }
}

function getTabBySessionId(sessionId) {
  const direct = tabBySession.get(sessionId)
  if (direct) return { tabId: direct, kind: 'main' }
  const child = childSessionToTab.get(sessionId)
  if (child) return { tabId: child, kind: 'child' }
  return null
}

function getTabByTargetId(targetId) {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.targetId === targetId) return tabId
  }
  return null
}

async function attachTab(tabId, opts = {}) {
  const debuggee = { tabId }
  await chrome.debugger.attach(debuggee, '1.3')
  await chrome.debugger.sendCommand(debuggee, 'Page.enable').catch(() => {})

  const info = /** @type {any} */ (await chrome.debugger.sendCommand(debuggee, 'Target.getTargetInfo'))
  const targetInfo = info?.targetInfo
  const targetId = String(targetInfo?.targetId || '').trim()
  if (!targetId) {
    throw new Error('Target.getTargetInfo returned no targetId')
  }

  const sid = nextSession++
  const sessionId = `cb-tab-${sid}`
  const attachOrder = sid

  tabs.set(tabId, { state: 'connected', sessionId, targetId, attachOrder })
  tabBySession.set(sessionId, tabId)
  void chrome.action.setTitle({
    tabId,
    title: 'Felo Browser Agent: attached (click to detach)',
  })

  if (!opts.skipAttachedEvent) {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId,
          targetInfo: { ...targetInfo, attached: true },
          waitingForDebugger: false,
        },
      },
    })
  }

  setBadge(tabId, 'on')
  await persistState()

  return { sessionId, targetId }
}

async function detachTab(tabId, reason) {
  const tab = tabs.get(tabId)

  // Send detach events for child sessions first.
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) {
      try {
        sendToRelay({
          method: 'forwardCDPEvent',
          params: {
            method: 'Target.detachedFromTarget',
            params: { sessionId: childSessionId, reason: 'parent_detached' },
          },
        })
      } catch {
        // Relay may be down.
      }
      childSessionToTab.delete(childSessionId)
    }
  }

  // Send detach event for main session.
  if (tab?.sessionId && tab?.targetId) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: tab.sessionId, targetId: tab.targetId, reason },
        },
      })
    } catch {
      // Relay may be down.
    }
  }

  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)

  try {
    await chrome.debugger.detach({ tabId })
  } catch {
    // May already be detached.
  }

  setBadge(tabId, 'off')
  void chrome.action.setTitle({
    tabId,
    title: 'Felo Browser Agent (click to attach/detach)',
  })

  await persistState()
}

async function connectOrToggleForActiveTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  const tabId = active?.id
  if (!tabId) return

  // Prevent concurrent operations on the same tab.
  if (tabOperationLocks.has(tabId)) return
  tabOperationLocks.add(tabId)

  try {
    if (reattachPending.has(tabId)) {
      reattachPending.delete(tabId)
      setBadge(tabId, 'off')
      void chrome.action.setTitle({
        tabId,
        title: 'Unclawned (click to attach/detach)',
      })
      return
    }

    const existing = tabs.get(tabId)
    if (existing?.state === 'connected') {
      await detachTab(tabId, 'toggle')
      return
    }

    // User is manually connecting — cancel any pending reconnect.
    cancelReconnect()

    tabs.set(tabId, { state: 'connecting' })
    setBadge(tabId, 'connecting')
    void chrome.action.setTitle({
      tabId,
        title: 'Unclawned: connecting to server…',
    })

    try {
      await ensureRelayConnection()
      await attachTab(tabId)
    } catch (err) {
      tabs.delete(tabId)
      setBadge(tabId, 'error')
      void chrome.action.setTitle({
        tabId,
        title: 'Unclawned: server not reachable (open options for setup)',
      })
      void maybeOpenHelpOnce()
      const message = err instanceof Error ? err.message : String(err)
      console.warn('attach failed', message, nowStack())
    }
  } finally {
    tabOperationLocks.delete(tabId)
  }
}

async function attachActiveTabIfNeeded() {
  if ([...tabs.values()].some(tab => tab.state === 'connected')) {
    await reannounceAttachedTabs()
    return
  }

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  const tabId = active?.id
  const url = String(active?.url || '')
  if (!tabId || !/^https?:\/\//i.test(url) || tabOperationLocks.has(tabId)) return

  tabOperationLocks.add(tabId)
  tabs.set(tabId, { state: 'connecting' })
  setBadge(tabId, 'connecting')
  try {
    await attachTab(tabId)
    await persistState()
    setBadge(tabId, 'on')
  } catch (err) {
    tabs.delete(tabId)
    setBadge(tabId, 'error')
    console.warn('automatic active-tab attach failed', err instanceof Error ? err.message : String(err))
  } finally {
    tabOperationLocks.delete(tabId)
  }
}

async function handleForwardCdpCommand(msg) {
  const method = String(msg?.params?.method || '').trim()
  const params = msg?.params?.params || undefined
  const sessionId = typeof msg?.params?.sessionId === 'string' ? msg.params.sessionId : undefined

  // If backend specified a specific tabId, use it directly — skip all resolution logic
  const specificTabId = typeof msg?.params?.tabId === 'number' ? msg.params.tabId : null
  if (specificTabId) {
    const debuggee = { tabId: specificTabId }
    if (method === 'Runtime.enable') {
      try {
        await chrome.debugger.sendCommand(debuggee, 'Runtime.disable')
        await new Promise(r => setTimeout(r, 50))
      } catch {}
      return await chrome.debugger.sendCommand(debuggee, 'Runtime.enable', params)
    }
    return await chrome.debugger.sendCommand(debuggee, method, params)
  }

  const bySession = sessionId ? getTabBySessionId(sessionId) : null
  const targetId = typeof params?.targetId === 'string' ? params.targetId : undefined
  const tabId =
    bySession?.tabId ||
    (targetId ? getTabByTargetId(targetId) : null) ||
    (() => {
      for (const [id, tab] of tabs.entries()) {
        if (tab.state === 'connected') return id
      }
      return null
    })()

  if (!tabId) throw new Error(`No attached tab for method ${method}`)

  /** @type {chrome.debugger.DebuggerSession} */
  const debuggee = { tabId }

  if (method === 'Runtime.enable') {
    try {
      await chrome.debugger.sendCommand(debuggee, 'Runtime.disable')
      await new Promise((r) => setTimeout(r, 50))
    } catch {
      // ignore
    }
    return await chrome.debugger.sendCommand(debuggee, 'Runtime.enable', params)
  }

  if (method === 'Target.createTarget') {
    const url = typeof params?.url === 'string' ? params.url : 'about:blank'
    const tab = await chrome.tabs.create({ url, active: false })
    if (!tab.id) throw new Error('Failed to create tab')
    await new Promise((r) => setTimeout(r, 100))
    const attached = await attachTab(tab.id)
    return { targetId: attached.targetId }
  }

  if (method === 'Target.closeTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toClose = target ? getTabByTargetId(target) : tabId
    if (!toClose) return { success: false }
    try {
      await chrome.tabs.remove(toClose)
    } catch {
      return { success: false }
    }
    return { success: true }
  }

  if (method === 'Target.activateTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toActivate = target ? getTabByTargetId(target) : tabId
    if (!toActivate) return {}
    const tab = await chrome.tabs.get(toActivate).catch(() => null)
    if (!tab) return {}
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
    }
    await chrome.tabs.update(toActivate, { active: true }).catch(() => {})
    return {}
  }

  const tabState = tabs.get(tabId)
  const mainSessionId = tabState?.sessionId
  const debuggerSession =
    sessionId && mainSessionId && sessionId !== mainSessionId
      ? { ...debuggee, sessionId }
      : debuggee

  return await chrome.debugger.sendCommand(debuggerSession, method, params)
}

function onDebuggerEvent(source, method, params) {
  const tabId = source.tabId
  if (!tabId) return
  const tab = tabs.get(tabId)
  if (!tab?.sessionId) return

  if (method === 'Target.attachedToTarget' && params?.sessionId) {
    childSessionToTab.set(String(params.sessionId), tabId)
  }

  if (method === 'Target.detachedFromTarget' && params?.sessionId) {
    childSessionToTab.delete(String(params.sessionId))
  }

  try {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        sessionId: source.sessionId || tab.sessionId,
        method,
        params,
      },
    })
  } catch {
    // Relay may be down.
  }
}

async function onDebuggerDetach(source, reason) {
  const tabId = source.tabId
  if (!tabId) return
  if (!tabs.has(tabId)) return

  // User explicitly cancelled or DevTools replaced the connection — respect their intent
  if (reason === 'canceled_by_user' || reason === 'replaced_with_devtools') {
    void detachTab(tabId, reason)
    return
  }

  // Check if tab still exists — distinguishes navigation from tab close
  let tabInfo
  try {
    tabInfo = await chrome.tabs.get(tabId)
  } catch {
    // Tab is gone (closed) — normal cleanup
    void detachTab(tabId, reason)
    return
  }

  if (tabInfo.url?.startsWith('chrome://') || tabInfo.url?.startsWith('chrome-extension://')) {
    void detachTab(tabId, reason)
    return
  }

  if (reattachPending.has(tabId)) return

  const oldTab = tabs.get(tabId)
  const oldSessionId = oldTab?.sessionId
  const oldTargetId = oldTab?.targetId

  if (oldSessionId) tabBySession.delete(oldSessionId)
  tabs.delete(tabId)
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
  }

  if (oldSessionId && oldTargetId) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: oldSessionId, targetId: oldTargetId, reason: 'navigation-reattach' },
        },
      })
    } catch {
      // Relay may be down.
    }
  }

  reattachPending.add(tabId)
  setBadge(tabId, 'connecting')
  void chrome.action.setTitle({
    tabId,
        title: 'Unclawned: re-attaching after navigation…',
  })

  // Extend re-attach window from 2.5 s to ~7.7 s (5 attempts).
  // SPAs and pages with heavy JS can take >2.5 s before the Chrome debugger
  // is attachable, causing all three original attempts to fail and leaving
  // the badge permanently off after every navigation.
  const delays = [200, 500, 1000, 2000, 4000]
  for (let attempt = 0; attempt < delays.length; attempt++) {
    await new Promise((r) => setTimeout(r, delays[attempt]))

    if (!reattachPending.has(tabId)) return

    try {
      await chrome.tabs.get(tabId)
    } catch {
      reattachPending.delete(tabId)
      setBadge(tabId, 'off')
      return
    }

    const relayUp = relayWs && relayWs.readyState === WebSocket.OPEN

    try {
      // When relay is down, still attach the debugger but skip sending the
      // relay event. reannounceAttachedTabs() will notify the relay once it
      // reconnects, so the tab stays tracked across transient relay drops.
      await attachTab(tabId, { skipAttachedEvent: !relayUp })
      reattachPending.delete(tabId)
      if (!relayUp) {
        setBadge(tabId, 'connecting')
        void chrome.action.setTitle({
          tabId,
          title: 'Unclawned: attached, waiting for relay reconnect…',
        })
      }
      return
    } catch {
      // continue retries
    }
  }

  reattachPending.delete(tabId)
  setBadge(tabId, 'off')
  void chrome.action.setTitle({
    tabId,
        title: 'Unclawned: re-attach failed (click to retry)',
  })
}

// Tab lifecycle listeners — clean up stale entries.
chrome.tabs.onRemoved.addListener((tabId) => void whenReady(() => {
  reattachPending.delete(tabId)
  if (!tabs.has(tabId)) return
  const tab = tabs.get(tabId)
  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
  }
  if (tab?.sessionId && tab?.targetId) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: tab.sessionId, targetId: tab.targetId, reason: 'tab_closed' },
        },
      })
    } catch {
      // Relay may be down.
    }
  }
  void persistState()
}))

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => void whenReady(() => {
  const tab = tabs.get(removedTabId)
  if (!tab) return
  tabs.delete(removedTabId)
  tabs.set(addedTabId, tab)
  if (tab.sessionId) {
    tabBySession.set(tab.sessionId, addedTabId)
  }
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === removedTabId) {
      childSessionToTab.set(childSessionId, addedTabId)
    }
  }
  setBadge(addedTabId, 'on')
  void persistState()
}))

// Register debugger listeners at module scope so detach/event handling works
// even when the relay WebSocket is down.
chrome.debugger.onEvent.addListener((...args) => void whenReady(() => onDebuggerEvent(...args)))
chrome.debugger.onDetach.addListener((...args) => void whenReady(() => onDebuggerDetach(...args)))

chrome.action.onClicked.addListener(() => void whenReady(() => connectOrToggleForActiveTab()))

// Refresh badge after navigation completes — service worker may have restarted
// during navigation, losing ephemeral badge state.
chrome.webNavigation.onCompleted.addListener(({ tabId, frameId }) => void whenReady(() => {
  if (frameId !== 0) return
  const tab = tabs.get(tabId)
  if (tab?.state === 'connected') {
    setBadge(tabId, relayWs && relayWs.readyState === WebSocket.OPEN ? 'on' : 'connecting')
  }
}))

// Refresh badge when user switches to an attached tab.
chrome.tabs.onActivated.addListener(({ tabId }) => void whenReady(() => {
  const tab = tabs.get(tabId)
  if (tab?.state === 'connected') {
    setBadge(tabId, relayWs && relayWs.readyState === WebSocket.OPEN ? 'on' : 'connecting')
  }
}))

chrome.runtime.onInstalled.addListener((details) => {
  // Only open options on fresh install, not on update
  if (details.reason === 'install') {
    void chrome.runtime.openOptionsPage()
  }
})

// MV3 keepalive via chrome.alarms — more reliable than setInterval across
// service worker restarts. Checks relay health and refreshes badges.
chrome.alarms.create('relay-keepalive', { periodInMinutes: 0.5 })

chrome.alarms.onAlarm.addListener(async (alarm) => {
  // Handle relay keepalive alarm
  if (alarm.name !== 'relay-keepalive') return
  await initPromise

  // Always refresh connection — remove the tabs.size === 0 check
  // Refresh badges (ephemeral in MV3).
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state === 'connected') {
      setBadge(tabId, relayWs && relayWs.readyState === WebSocket.OPEN ? 'on' : 'connecting')
    }
  }

  // If relay is down and no active connect attempt, force a reconnect now.
  // Do NOT check reconnectTimer — that flag can be stale after the service
  // worker was suspended and the timer lost. The alarm is the authoritative
  // heartbeat: if disconnected and no live promise, try immediately.
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) {
    if (!relayConnectPromise) {
      cancelReconnect() // clear any stale timer
      console.log('Keepalive: reconnecting to server...')
      await ensureRelayConnection().catch(() => {
        scheduleReconnect()
      })
    }
  }
})

// Older builds talked to the hosted Felo backend and saved its address (and a
// felo_ token) in storage, which survives reloads and updates. The hosted
// backend is gone, so move those installs to the local CLI once.
const SETTINGS_VERSION = 2

async function migrateSettings() {
  try {
    const stored = await chrome.storage.local.get(['serverUrl', 'settingsVersion'])
    if ((stored.settingsVersion || 0) >= SETTINGS_VERSION) {
      if (!stored.serverUrl) await chrome.storage.local.set({ serverUrl: SERVER_URL })
      return
    }
    const url = String(stored.serverUrl || '')
    const isLocal = url.includes('localhost') || url.includes('127.0.0.1')
    if (!isLocal) {
      if (url) console.log(`Replacing old server address ${url} with ${SERVER_URL}`)
      await chrome.storage.local.set({ serverUrl: SERVER_URL })
      await chrome.storage.local.remove('userToken')
    }
    await chrome.storage.local.set({ settingsVersion: SETTINGS_VERSION })
  } catch {
    // Storage errors fall back to the default address in getConnectionSettings.
  }
}

// Rehydrate state on service worker startup. Split: rehydration is the gate
// (fast), relay reconnect runs in background (slow, non-blocking).
const initPromise = migrateSettings().then(() => rehydrateState())

initPromise.then(() => {
  ensureRelayConnection().then(async () => {
    reconnectAttempt = 0
    await reannounceAttachedTabs()
  }).catch(() => {
    scheduleReconnect()
  })
})

// Shared gate: all state-dependent handlers await this before accessing maps.
async function whenReady(fn) {
  await initPromise
  return fn()
}

// Relay check handler for the options page. The service worker has
// host_permissions and bypasses CORS preflight, so the options page
// delegates token-validation requests here.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'relayCheck') return false
  const { url, token } = msg
  const headers = token ? { 'x-unclawned-relay-token': token } : {}
  fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(2000) })
    .then(async (res) => {
      const contentType = String(res.headers.get('content-type') || '')
      let json = null
      if (contentType.includes('application/json')) {
        try {
          json = await res.json()
        } catch {
          json = null
        }
      }
      sendResponse({ status: res.status, ok: res.ok, contentType, json })
    })
    .catch((err) => sendResponse({ status: 0, ok: false, error: String(err) }))
  return true
})

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'disconnect') {
    cancelReconnect()
    if (relayWs) {
      relayWs.close()
      relayWs = null
    }
    relayUserToken = ''
  }
  if (msg?.type === 'reconnect') {
    cancelReconnect()
    ensureRelayConnection().then(() => {
      reconnectAttempt = 0
      lastRelayError = ''
    }).catch((err) => {
      lastRelayError = err instanceof Error ? err.message : String(err)
      scheduleReconnect()
    })
  }
  if (msg?.type === 'get-relay-status') {
    const connected = relayWs ? relayWs.readyState === WebSocket.OPEN : false
    getConnectionSettings()
      .then(({ serverUrl }) => sendResponse({ connected, serverUrl: (connected && activeServerUrl) || serverUrl, lastError: connected ? '' : lastRelayError }))
      .catch((err) => sendResponse({ connected, serverUrl: '', lastError: err instanceof Error ? err.message : String(err) }))
    return true
  }
  return false
})

// Screenshot handler for Phase 1 recording
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'CAPTURE_SCREENSHOT') {
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'jpeg', quality: 80 }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        console.warn('[Background] Screenshot capture failed:', chrome.runtime.lastError);
        sendResponse({ screenshot: null });
      } else {
        console.log('[Background] Screenshot captured, size:', Math.round(dataUrl.length * 0.75 / 1024) + 'KB');
        sendResponse({ screenshot: dataUrl });
      }
    });
    return true; // Keep channel open for async response
  }
});

// ============================================
// Multi-Tab Recording Session Coordinator
// ============================================

// Storage-backed helpers — survive MV3 service worker restarts across tabs
async function getRecordingSession() {
  try {
    const stored = await chrome.storage.session.get(['recordingSession']);
    return stored.recordingSession || null;
  } catch (err) {
    console.warn('[Background] Failed to get recording session:', err);
    return null;
  }
}

async function setRecordingSession(session) {
  try {
    await chrome.storage.session.set({ recordingSession: session });
    console.log('[Background] Recording session persisted:', session?.sessionId);
  } catch (err) {
    console.warn('[Background] Failed to set recording session:', err);
  }
}

async function clearRecordingSession() {
  try {
    await chrome.storage.session.remove(['recordingSession']);
    console.log('[Background] Recording session cleared');
  } catch (err) {
    console.warn('[Background] Failed to clear recording session:', err);
  }
}

// In-memory session — used for event/registry collection within a running worker
let recordingSession = null;
let readySites = new Set();  // Track which sites have working content scripts
let recordingStartTime = null;  // Track when recording started

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  // START RECORDING across all tabs
  if (request.type === 'START_RECORDING') {
    (async () => {
      const session = {
        isRecording: true,
        sessionId: generateUUID(),
        skillName: request.skillName || 'Unnamed skill',
        skillDetails: request.skillDetails || '',
        startUrl: request.url || 'unknown',
        startTime: Date.now()
      };

      // Persist metadata to storage so other tabs can query it after worker restart
      await setRecordingSession(session);

      // Also keep in-memory for event collection in this worker instance
      recordingSession = {
        ...session,
        endTime: null,
        totalDuration: null,
        events: [],
        elementRegistry: {},
        blockedSites: [],
      };
      recordingStartTime = recordingSession.startTime;

      console.log('[Background] Recording started. SessionId:', session.sessionId, 'URL:', request.url);
      sendResponse({ success: true, sessionId: session.sessionId });
    })();
    return true;
  }

  // RECORD EVENT from content script (any tab)
  if (request.type === 'RECORD_EVENT') {
    if (!recordingSession || !recordingSession.isRecording) {
      sendResponse({ success: false, error: 'No active recording session' });
      return true;
    }

    const event = request.event;
    event.url = request.url; // Add URL to event
    event.tabId = sender.tab.id; // Track which tab

    recordingSession.events.push(event);

    // Merge element registry from content script
    if (request.elementRegistry) {
      Object.assign(recordingSession.elementRegistry, request.elementRegistry);
    }

    console.log('[Background] Event recorded:', event.type, 'URL:', request.url, 'Total events:', recordingSession.events.length);
    sendResponse({ success: true });
    return true;
  }

  // STOP RECORDING
  if (request.type === 'STOP_RECORDING') {
    (async () => {
      const storedSession = await getRecordingSession();
      if (!storedSession && !recordingSession) {
        sendResponse({ success: false, error: 'No active recording session' });
        return;
      }

      // Update in-memory session if it exists
      if (recordingSession) {
        recordingSession.isRecording = false;
        recordingSession.endTime = Date.now();
        recordingSession.totalDuration = recordingSession.endTime - recordingSession.startTime;
      }

      // Mark storage as stopped (keep for GET_SESSION_DATA queries)
      if (storedSession) {
        await setRecordingSession({ ...storedSession, isRecording: false });
      }

      const sessionData = recordingSession ? { ...recordingSession } : storedSession;
      console.log('[Background] Recording stopped. Total events:', sessionData?.events?.length || 0);

      sendResponse({ success: true, sessionData });
    })();
    return true;
  }

  // GET RECORDING STATE (for tabs that want to know if recording is active)
  if (request.type === 'GET_RECORDING_STATE') {
    (async () => {
      const session = await getRecordingSession();

      if (!session) {
        sendResponse({ isRecording: false, sessionId: null });
      } else {
        sendResponse({
          isRecording: session.isRecording,
          sessionId: session.sessionId,
          skillName: session.skillName,
          skillDetails: session.skillDetails,
          startUrl: session.startUrl
        });
      }
    })();
    return true; // Keep channel open for async response
  }

  // GET SESSION DATA (for tabs calling stopRecording to get merged data)
  if (request.type === 'GET_SESSION_DATA') {
    if (!recordingSession) {
      sendResponse({ success: false, sessionData: null, error: 'No active session' });
      return true;
    }

    const sessionData = { ...recordingSession };
    console.log('[Background] Returning session data. Total events:', sessionData.events.length);

    sendResponse({ success: true, sessionData: sessionData });
    return true;
  }

  // CLEAR SESSION (explicitly clear after getting data)
  if (request.type === 'CLEAR_SESSION') {
    (async () => {
      recordingSession = null;
      await clearRecordingSession();
      sendResponse({ success: true });
    })();
    return true;
  }

  // CONTENT SCRIPT READY (mark site as recordable)
  if (request.type === 'CONTENT_SCRIPT_READY') {
    readySites.add(request.hostname);
    console.log('[Background] Content script ready on:', request.hostname);
    sendResponse({ success: true });
    return true;
  }

  // CHECK IF SITE IS BLOCKED (frontend asks if recording is possible on current URL)
  if (request.type === 'CHECK_SITE_RECORDABLE') {
    if (!recordingSession) {
      sendResponse({ isRecordable: false, reason: 'No active recording' });
      return true;
    }

    const isRecordable = readySites.has(request.hostname);

    // If not recordable and recording is active, mark as blocked
    if (!isRecordable && recordingSession.isRecording) {
      recordingSession.blockedSites.push({
        hostname: request.hostname,
        url: request.url,
        timestamp: Date.now(),
        duration: 0  // Will update on unblock
      });

      console.log('[Background] Recording blocked on site:', request.hostname);

      sendResponse({
        isRecordable: false,
        reason: 'Content script not available on this site',
        hostname: request.hostname
      });
      return true;
    }

    sendResponse({ isRecordable: true });
    return true;
  }

});

// Helper function to generate UUID
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
