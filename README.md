# Tradovate Discord Alerts (Chrome extension v1.2.0)

Posts Tradovate fills to Discord as embedded alerts:
- **TRADE ENTRY** (green): opening or adding to a LONG or SHORT position.
- **TRIM EXIT** (pink): reducing or closing a position, with P&L in points and dollars.
- An optional role ping goes above each alert. @everyone and @here are always blocked.

## Install
1. Unzip, open `chrome://extensions`, and turn on **Developer mode**.
2. Click **Load unpacked** and select the unzipped extension folder (the one containing `manifest.json`).
3. Click the extension icon and paste your Discord webhook URL. Optionally add a role ID to ping (Discord: turn on Developer Mode, right-click the role, then **Copy Role ID**). Then **Save** and **Send test**.
4. Refresh trader.tradovate.com.

## Files
| File | What it does |
|---|---|
| `manifest.json` | Extension config: permissions, scripts, popup. |
| `tvparser.js` | Shared parser for Tradovate's stream. Caches accounts, contracts and positions; turns each new fill into ENTRY or TRIM alerts, tracking the average entry price. |
| `inject.js` | Runs inside the Tradovate page. Wraps `WebSocket` so every connection's messages go to the parser, and reports status. |
| `bridge.js` | Relays fills and status from the page to the background script. |
| `background.js` | Validates fills, applies settings, computes P&L, builds the Discord embeds and posts them. Also keeps the activity log and runs Deep capture. |
| `options.html` / `options.js` | Popup: settings, Send test, the Status panel and the Deep capture switch. |

## How fills are captured
- **Page hook (default):** `inject.js` reads the page's WebSocket messages. Only fills created after page load are posted, never history.
- **Deep capture (popup switch):** uses `chrome.debugger` to read Tradovate's network traffic, including sockets opened in workers. It's read-only. Chrome shows a "debugging this browser" bar while it's on.
- Tradovate may report one execution as both a `fill` and an `executionReport`. Whichever arrives first is used and the other is skipped, so each execution posts once.

## P&L
Points = exit − average entry (reversed for shorts). Dollars = points × point value × contracts.
Point values are in `POINT_VALUES` in `background.js`: ES 50, MES 5, NQ 20, MNQ 2, CL 1000, MCL 100,
GC 100, MGC 10, SI 5000, SIL 1000, PL 50. Other symbols post without a PNL line.

## Safety
- Only reads fills; it can't place, change or cancel orders, and never sees passwords.
- Only accepts data from `*trader.tradovate.com` pages, only posts to `discord.com` webhooks, validates every field, and caps posting at 30 alerts per minute.
- The webhook URL stays in Chrome's local extension storage. "Copy diagnostics" never includes it.
- Anyone with the webhook URL can post to that channel, so keep it private. If it leaks, delete it in Discord and make a new one.

## Troubleshooting
Open the popup on the Tradovate tab. The Status line and activity log show each fill and whether it posted or why it was skipped.
If the status is orange, turn on **Deep capture**.
