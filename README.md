# Unclawned Chrome extension

> **Status: not finished.** It works with a lot of bugs. Use it for experiments only.

This Chrome extension lets the [Unclawned CLI](https://github.com/Manolis8/unclawned-local) control your real Chrome browser: open tabs, click, type, and read pages, using your normal logged-in sessions. On its own it does nothing. It needs the CLI running on the same computer.

## How it connects

```
Unclawned CLI  ◄── WebSocket (localhost) ──►  this extension  ──►  your Chrome tabs
```

- The extension opens a WebSocket to `<server URL>/extension?token=<token>`.
- **Default server URL is `ws://localhost:3011`**, which is the CLI's MCP bridge mode (`node bin/mcp-bridge.js`).
- For the normal interactive CLI (`npm start`), which listens on **`ws://localhost:3001`**, open the extension's **Options**, paste a token starting with `felo_` (for example `felo_local_dev`) and click **Save**. That switches it to port 3001.
- On localhost any `felo_` token works; the CLI registers it on first connect.
- The extension uses Chrome's `debugger` permission to drive tabs, so Chrome shows a "started debugging this browser" bar while it's in use. That's expected.

## Install

1. Download this repo (`git clone https://github.com/Manolis8/felo-extension.git` or **Code → Download ZIP** and unzip).
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the folder.
5. Pin the extension from the puzzle icon in the toolbar.
6. Install and start the CLI by following the [unclawned-local README](https://github.com/Manolis8/unclawned-local#install).

## Check that it works

- Start the CLI, then click the extension icon. The popup shows **Connected** or **Disconnected**; click **Connect** if it's disconnected.
- The badge shows `…` while connecting, `ON` on a tab the agent is controlling, and `!` on an error.
- If it stays disconnected, check the port in Options matches the CLI (`3001` by default, or whatever `CLI_PORT` is set to).

## Files

```
manifest.json         extension config (Manifest V3)
background.js         service worker: WebSocket to the CLI + tab control via chrome.debugger
background-utils.js   reconnect/backoff helpers
content.js            page bridge
extension/            scripts injected into pages (recording, bridge)
popup.html/.js        toolbar popup (status)
options.html/.js      settings page (token / server)
icons/
```

## Known problems

- The default port (3011) and the CLI's default port (3001) don't match, so you have to set it in Options.
- Reconnection after Chrome sleeps or the CLI restarts is not always reliable; reload the extension if it gets stuck.
- Some text in the UI still mentions `unclawned.com`, which was a planned hosted version and isn't needed for local use.

## Security

This extension can read and control every tab. Only connect it to a CLI running on your own machine.
