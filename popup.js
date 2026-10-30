// Popup script for Unclawned Browser Agent

document.addEventListener('DOMContentLoaded', async () => {
  const statusEl = document.getElementById('status')
  const connectBtn = document.getElementById('connect')
  const disconnectBtn = document.getElementById('disconnect')

  const detailEl = document.getElementById('detail')

  async function updateStatus() {
    let connected = false
    let serverUrl = ''
    let lastError = ''
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'get-relay-status' })
      connected = resp?.connected === true
      serverUrl = resp?.serverUrl || ''
      lastError = resp?.lastError || ''
    } catch {}

    const lines = []
    if (serverUrl) lines.push(`Address: ${serverUrl}`)
    if (!connected && lastError) lines.push(`Last error: ${lastError}`)
    detailEl.textContent = lines.join('\n')
    detailEl.style.whiteSpace = 'pre-line'

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
