const SERVER_URL = 'ws://localhost:3001'

function setStatus(kind, message) {
  const el = document.getElementById('status')
  el.className = 'status ' + kind
  el.textContent = message
}

async function load() {
  const stored = await chrome.storage.local.get(['userToken'])
  const token = stored.userToken || ''
  document.getElementById('user-token').value = token
  if (token && token.startsWith('felo_')) {
    setStatus('ok', '✓ Connected to Unclawned — token saved')
  } else if (token) {
    setStatus('error', 'Invalid token format — paste your felo_xxx key')
  }
}

async function save() {
  const userToken = document.getElementById('user-token').value.trim()
  if (!userToken) {
    setStatus('error', 'Please paste your token from unclawned.com/dashboard')
    return
  }
  if (!userToken.startsWith('felo_')) {
    setStatus('error', 'Token must start with felo_ — get it from your dashboard')
    return
  }
  await chrome.storage.local.set({ userToken, serverUrl: SERVER_URL })
  setStatus('ok', '✓ Saved! Extension will connect automatically.')
  // Notify background to reconnect
  chrome.runtime.sendMessage({ type: 'reconnect' }).catch(() => {})
}

document.getElementById('save').addEventListener('click', () => void save())
void load()