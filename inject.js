// Runs in the Tradovate page's JavaScript world at document_start (after tvparser.js).
// Wraps window.WebSocket so every socket the page opens is read by the parser,
// whatever host it uses. Reports diagnostics for the popup's status panel.
(() => {
  if (window.__awFillRelayInstalled) return;
  // Skip sandboxed/blank helper frames: they have no real origin, can't relay
  // messages, and never carry trading data.
  if (!location.origin || location.origin === 'null') return;
  if (typeof window.__awCreateTvParser !== 'function') return;
  window.__awFillRelayInstalled = true;

  const TAG = 'TV_FILL_RELAY';
  const post = (type, payload) => {
    try { window.postMessage({ source: TAG, type, payload }, location.origin); } catch (_) {}
  };

  const parser = window.__awCreateTvParser((fill) => post('fill', fill));
  const diag = { hooked: true, frame: window === window.top ? 'top' : 'iframe', socketsOpened: [], workers: 0, sharedWorkers: 0 };

  // ---- WebSocket wrapper (all hosts) ---------------------------------------
  const NativeWS = window.WebSocket;
  function RelayWebSocket(url, protocols) {
    const ws = protocols !== undefined ? new NativeWS(url, protocols) : new NativeWS(url);
    const u = String(url);
    if (diag.socketsOpened.length < 20) diag.socketsOpened.push(u.replace(/[?#].*$/, ''));
    try { ws.addEventListener('message', (ev) => { try { parser.handleRaw(ev.data, u); } catch (_) {} }); } catch (_) {}
    return ws;
  }
  RelayWebSocket.prototype = NativeWS.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
    Object.defineProperty(RelayWebSocket, k, { value: NativeWS[k] });
  }
  window.WebSocket = RelayWebSocket;

  // ---- Count workers (sockets opened inside them can't be hooked here) -----
  for (const [name, field] of [['Worker', 'workers'], ['SharedWorker', 'sharedWorkers']]) {
    const Native = window[name];
    if (typeof Native !== 'function') continue;
    const Wrapped = function (...args) {
      diag[field]++;
      return new Native(...args);
    };
    Wrapped.prototype = Native.prototype;
    window[name] = Wrapped;
  }

  // ---- Periodic status report ----------------------------------------------
  let last = '';
  setInterval(() => {
    try {
      const snapshot = JSON.stringify({ ...diag, ...parser.stats });
      if (snapshot !== last) {
        last = snapshot;
        post('stats', JSON.parse(snapshot));
      }
    } catch (_) {}
  }, 2000);
})();
