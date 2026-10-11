// Popup script for Unclawned Browser Agent

document.addEventListener('DOMContentLoaded', async () => {
  const statusEl = document.getElementById('status')
  const connectBtn = document.getElementById('connect')
  const disconnectBtn = document.getElementById('disconnect')

  async function updateStatus() {
    let connected = false
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'get-relay-status' })
      connected = resp?.connected === true
    } catch {}

    if (connected) {
      statusEl.textContent = 'Connected'
      statusEl.className = 'status ok'
      connectBtn.style.display = 'none'
      disconnectBtn.style.display = 'inline-block'
    } else {
      statusEl.textContent = 'Disconnected'
      statusEl.className = 'status'
      connectBtn.style.display = 'inline-block'
      disconnectBtn.style.display = 'none'
    }
  }

  connectBtn.addEventListener('click', async () => {
    statusEl.textContent = 'Connecting…'
    connectBtn.disabled = true
    try {
      await chrome.runtime.sendMessage({ type: 'reconnect' })
    } catch {}
    // Give the background a moment to connect, then refresh status
    await new Promise(r => setTimeout(r, 1500))
    connectBtn.disabled = false
    await updateStatus()
  })

  disconnectBtn.addEventListener('click', async () => {
    chrome.runtime.sendMessage({ type: 'disconnect' }).catch(() => {})
    await new Promise(r => setTimeout(r, 300))
    await updateStatus()
  })

  await updateStatus()
})
