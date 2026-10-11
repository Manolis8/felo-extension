// Content script for Unclawned Browser Agent
// Listens for auth token messages from the Unclawned web app

//content.js is the script that runs in the browser and listens for auth token messages from the Unclawned web app

window.addEventListener('message', async (event) => {
  const origin = event.origin

  if (
    origin !== 'https://unclawned.com' &&
    !origin.endsWith('.vercel.app') &&
    origin !== 'http://localhost:3000'
  ) return

  if (event.data?.type !== 'FELO_AUTH_TOKEN') return
  if (event.data?.type === 'FELO_DISCONNECT') {
    await chrome.storage.local.remove(['userToken'])
    chrome.runtime.sendMessage({ type: 'disconnect' }).catch(() => {})
    console.log('Unclawned: disconnected')
    return
  }

  if (event.data?.type !== 'FELO_AUTH_TOKEN') return
  const { token } = event.data
  if (!token) return
  await chrome.storage.local.set({ userToken: token })
  console.log('Unclawned: token saved, reconnecting...')
  chrome.runtime.sendMessage({ type: 'reconnect' }).catch(() => {})
  const allowedOrigins = [
    'https://unclawned.com',
    'https://*.vercel.app'
  ]
  

  
  if (
    origin === 'https://unclawned.com' ||
    origin.endsWith('.vercel.app') ||
    origin === 'http://localhost:3000'
  ) {
    window.parent.postMessage({ type: 'FELO_TOKEN_RECEIVED' }, origin)
  }
})
