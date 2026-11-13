// Isolated-world content script: relays fills and status from the page script
// to the background service worker (the page world has no chrome.runtime access).
function relay(msg) {
  // After the extension is reloaded, scripts left in an open Tradovate tab lose
  // their connection ("Extension context invalidated"). Stay quiet until refresh.
  try {
    if (!chrome.runtime?.id) return;
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch (_) {}
}

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  const m = e.data;
  if (!m || m.source !== 'TV_FILL_RELAY') return;
  if (m.type === 'fill') relay({ type: 'TV_FILL', payload: m.payload, via: 'page' });
  else if (m.type === 'stats') relay({ type: 'TV_STATS', payload: m.payload });
});
