const DEFAULT_SERVER_URL = 'ws://localhost:3001'

function setStatus(kind, message) {
  const el = document.getElementById('status')
  el.className = 'status ' + kind
  el.textContent = message
}

async function refreshStatus() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'get-relay-status' })
    if (resp?.connected) setStatus('ok', '✓ Connected to the CLI')
    else setStatus('', 'Not connected. Is the CLI running?')
  } catch {
    setStatus('', '')
  }
}

async function load() {
  const stored = await chrome.storage.local.get(['serverUrl'])
  document.getElementById('server-url').value = stored.serverUrl || DEFAULT_SERVER_URL
  await refreshStatus()
}

async function save() {
  const serverUrl = document.getElementById('server-url').value.trim() || DEFAULT_SERVER_URL
  if (!/^wss?:\/\//.test(serverUrl)) {
    setStatus('error', 'Address must start with ws:// (for example ws://localhost:3001)')
    return
  }
  await chrome.storage.local.set({ serverUrl })
  setStatus('', 'Saved. Reconnecting…')
  await chrome.runtime.sendMessage({ type: 'disconnect' }).catch(() => {})
  await chrome.runtime.sendMessage({ type: 'reconnect' }).catch(() => {})
  setTimeout(() => void refreshStatus(), 1500)
}

document.getElementById('save').addEventListener('click', () => void save())
void load()
