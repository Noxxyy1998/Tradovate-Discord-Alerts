// MV3 service worker
importScripts('tvparser.js');

const DEFAULTS = {
  webhookUrl: '',
  enabled: true,
  includeDemo: true,
  accountFilter: '', // comma-separated account names; blank = all
  pingRoleId: '', // Discord role to ping on every alert; blank = no ping
  deepCapture: false // read Tradovate traffic via Chrome's debugger (works even inside workers)
};

const ROLE_ID_RE = /^\d{17,20}$/;

const getSettings = () => chrome.storage.local.get(DEFAULTS);

// ---- Status / activity log (shown in the popup) ---------------------------
// Kept in session storage: cleared when Chrome closes, never leaves the browser.
let statusCache = null;
async function getStatus() {
  if (!statusCache) {
    const { status } = await chrome.storage.session.get('status');
    statusCache = status || { pages: {}, sockets: [], events: [], deep: {} };
  }
  return statusCache;
}
let saveTimer = null;
function saveStatus() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.session.set({ status: statusCache }).catch(() => {}), 300);
}
async function logEvent(text) {
  const st = await getStatus();
  const t = new Date().toLocaleTimeString('en-US', { hour12: false });
  st.events.unshift(`${t}  ${text}`);
  st.events = st.events.slice(0, 25);
  saveStatus();
}

// ---- chrome.webRequest: see every socket Tradovate opens -----------------
// Only the handshake is visible here (not messages). tabId -1 means the socket
// was opened by a shared/background worker rather than the page itself.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    (async () => {
      const st = await getStatus();
      const url = details.url.replace(/[?#].*$/, '');
      const entry = `${url}${details.tabId < 0 ? '  (worker)' : ''}`;
      if (!st.sockets.includes(entry)) {
        st.sockets.unshift(entry);
        st.sockets = st.sockets.slice(0, 12);
        saveStatus();
      }
    })();
    const host = new URL(details.url).hostname;
    if (details.tabId < 0 || /^md/i.test(host)) return;
    const env = /^live/i.test(host) ? 'LIVE' : /^demo/i.test(host) ? 'DEMO' : '';
    if (!env) return;
    chrome.action.setBadgeText({ text: env, tabId: details.tabId }).catch(() => {});
    chrome.action
      .setBadgeBackgroundColor({ color: env === 'LIVE' ? '#c0392b' : '#2980b9', tabId: details.tabId })
      .catch(() => {});
  },
  { urls: ['*://*.tradovateapi.com/*', '*://*.tradovate.com/*', '*://*.ninjatrader.com/*'], types: ['websocket'] }
);

// ---- Security checks -------------------------------------------------------
// Only ever POST to a real Discord webhook, even if storage were tampered with.
const WEBHOOK_RE = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;

// Only accept fills relayed from a Tradovate page, never from anywhere else.
function fromTradovate(sender) {
  try {
    const host = new URL(sender.origin || sender.url).hostname;
    return sender.id === chrome.runtime.id && (host === 'tradovate.com' || host.endsWith('.tradovate.com'));
  } catch {
    return false;
  }
}

// Strict shape check on every fill before anything is posted. Rejects malformed
// or injected content (e.g. text crafted to look like a different alert).
const SYMBOL_RE = /^([A-Z0-9.-]{1,24}|contract#\d{1,12})$/;
const isPosInt = (n) => Number.isInteger(n) && n > 0 && n <= 10000;
function validFill(p) {
  return (
    p && typeof p === 'object' &&
    p.fillId != null && /^(er)?\d{1,20}$/.test(String(p.fillId)) &&
    typeof p.symbol === 'string' && SYMBOL_RE.test(p.symbol) &&
    (p.side === 'Buy' || p.side === 'Sell') &&
    typeof p.price === 'number' && Number.isFinite(p.price) && p.price > 0 &&
    isPosInt(p.qty) &&
    typeof p.timestamp === 'string' && Number.isFinite(Date.parse(p.timestamp)) &&
    Array.isArray(p.alerts) && p.alerts.length >= 1 && p.alerts.length <= 2 &&
    p.alerts.every(
      (a) =>
        (a.kind === 'entry' || a.kind === 'trim') && isPosInt(a.qty) &&
        (a.avgEntry == null || (typeof a.avgEntry === 'number' && Number.isFinite(a.avgEntry) && a.avgEntry > 0)) &&
        (a.closedSide == null || a.closedSide === 'LONG' || a.closedSide === 'SHORT')
    ) &&
    p.alerts.reduce((sum, a) => sum + a.qty, 0) === p.qty
  );
}

// Cap posts per minute so a bug or a hostile page can't flood the channel.
const MAX_POSTS_PER_MIN = 30;
let recentPosts = [];
function underRateCap() {
  const now = Date.now();
  recentPosts = recentPosts.filter((t) => now - t < 60_000);
  if (recentPosts.length >= MAX_POSTS_PER_MIN) return false;
  recentPosts.push(now);
  return true;
}

// ---- De-dupe across frames/tabs ------------------------------------------
async function alreadySent(fillId) {
  const { sentFills = [] } = await chrome.storage.session.get('sentFills');
  if (sentFills.includes(fillId)) return true;
  sentFills.push(fillId);
  await chrome.storage.session.set({ sentFills: sentFills.slice(-500) });
  return false;
}

// ---- Discord -------------------------------------------------------------
const DISCLAIMER =
  '*Nothing shared here is financial advice. Always do your own research and manage your own risk when trading.*';

// Discord timestamp tag: renders in each viewer's own local time zone
function discordTime(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? `<t:${Math.floor(ms / 1000)}:f>` : String(iso);
}

// One fill can produce one or two alerts (see classifyFill in inject.js):
//   entry -> TRADE ENTRY (opening or adding to a long OR a short)
//   trim  -> TRIM EXIT   (reducing/closing an existing position)
// ---- P&L -------------------------------------------------------------------
// Dollars per 1.00 point move, per contract. Keyed by root symbol.
const POINT_VALUES = {
  // Equity indices
  ES: 50, MES: 5,       // S&P 500
  NQ: 20, MNQ: 2,       // Nasdaq 100
  // Energy
  CL: 1000, MCL: 100,   // WTI crude oil
  // Metals
  GC: 100, MGC: 10,     // Gold
  SI: 5000, SIL: 1000,  // Silver
  PL: 50                // Platinum
};

// "NQZ6" -> "NQ", "MNQH27" -> "MNQ" (strip month code + year)
function rootSymbol(symbol) {
  const m = /^([A-Z0-9]+?)[FGHJKMNQUVXZ]\d{1,2}$/.exec(symbol);
  return m ? m[1] : symbol;
}

// Returns { points, dollars } or null if entry price or point value is unknown
function calcPnl(symbol, closedSide, avgEntry, exitPrice, qty) {
  const pv = POINT_VALUES[rootSymbol(symbol)];
  if (!pv || avgEntry == null) return null;
  const points = closedSide === 'SHORT' ? avgEntry - exitPrice : exitPrice - avgEntry;
  return { points, dollars: points * pv * qty };
}

function fmtPoints(n) {
  const abs = Number(Math.abs(n).toFixed(7)); // also clears float noise like 0.000499999
  const txt = abs.toFixed(Math.max(2, (String(abs).split('.')[1] || '').length));
  return `${n >= 0 ? '+' : '−'}${txt} pts`;
}
const fmtDollars = (n) =>
  `${n >= 0 ? '+' : '−'}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const COLOR_ENTRY = 0x2ecc71; // green side panel
const COLOR_TRIM = 0xff69b4;  // pink side panel

function buildDiscordBodies(p, isTest = false, pingRoleId = '') {
  // Ping only the one configured role; @everyone/@here/users stay blocked.
  // The ping goes in the message text, since mentions inside embeds don't notify.
  const role = ROLE_ID_RE.test(pingRoleId) ? pingRoleId : '';
  const test = isTest ? '[TEST] ' : '';
  // An entry fill's direction is the position's direction: Buy opens/adds LONG, Sell opens/adds SHORT
  const direction = p.side === 'Sell' ? 'SHORT' : 'LONG';
  const time = discordTime(p.timestamp || new Date().toISOString());
  const alerts = p.alerts?.length ? p.alerts : [{ kind: 'entry', qty: p.qty }];

  return alerts.map((a) => {
    const pnl = a.kind === 'trim' ? calcPnl(p.symbol, a.closedSide, a.avgEntry, p.price, a.qty) : null;
    const embed =
      a.kind === 'trim'
        ? {
            title: `${test}TRIM EXIT — ${p.symbol}`,
            color: COLOR_TRIM,
            description: [
              `**Price:** ${p.price}`,
              `**QTY:** ${a.qty}`,
              ...(pnl ? [`**PNL:** ${fmtPoints(pnl.points)} (${fmtDollars(pnl.dollars)})`] : []),
              `**TIMESTAMP:** ${time}`,
              '',
              DISCLAIMER
            ].join('\n')
          }
        : {
            author: { name: 'Trade Alert' },
            title: `${test}TRADE ENTRY — ${p.symbol} ${direction}`,
            color: COLOR_ENTRY,
            description: [
              `**Entry:** ${p.price}`,
              `**QTY:** ${a.qty}`,
              `**TIMESTAMP:** ${time}`,
              '',
              DISCLAIMER
            ].join('\n')
          };
    const body = {
      username: 'Trade Alerts',
      embeds: [embed],
      allowed_mentions: { parse: [], roles: role ? [role] : [] }
    };
    if (role) body.content = `<@&${role}>`;
    return body;
  });
}

async function postToDiscord(webhookUrl, body, attempt = 0) {
  if (!WEBHOOK_RE.test(webhookUrl)) throw new Error('Saved URL is not a Discord webhook; refusing to send.');
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (res.status === 429 && attempt < 3) {
    const data = await res.json().catch(() => ({}));
    const waitMs = Math.ceil((data.retry_after ?? 1) * 1000);
    await new Promise((r) => setTimeout(r, waitMs));
    return postToDiscord(webhookUrl, body, attempt + 1);
  }
  if (!res.ok) throw new Error(`Discord ${res.status}: ${await res.text()}`);
}

// Simple serial queue so bursts of partial fills keep their order
let queue = Promise.resolve();
const enqueue = (fn) =>
  (queue = queue.then(fn).catch((e) => {
    console.error('[Tradovate Discord Alerts]', e);
    logEvent(`❌ Discord error: ${String(e.message || e).slice(0, 120)}`);
  }));

const describe = (p) => `${p.side} ${p.qty} ${p.symbol} @ ${p.price}`;

// Every fill goes through here, from the page hook or from Deep capture.
function handleFill(p, via) {
  if (!validFill(p)) {
    console.warn('[Tradovate Discord Alerts] Rejected malformed fill', p);
    logEvent(`⚠️ Ignored a fill with unexpected data (${via})`);
    return;
  }
  enqueue(async () => {
    if (await alreadySent(p.fillId)) return; // same fill seen by page hook and Deep capture
    const kinds = p.alerts.map((a) => (a.kind === 'trim' ? 'TRIM' : 'ENTRY')).join(' + ');
    await logEvent(`Fill seen: ${describe(p)} → ${kinds} [${p.environment}, ${via}]`);
    const s = await getSettings();
    if (!s.enabled) return logEvent('   Skipped: extension is switched off');
    if (!s.webhookUrl) return logEvent('   Skipped: no webhook URL saved');
    if (!s.includeDemo && p.environment === 'DEMO')
      return logEvent('   Skipped: "Post demo/sim fills" is off (prop evals usually run on demo)');
    const filter = s.accountFilter.split(',').map((x) => x.trim()).filter(Boolean);
    if (filter.length && !filter.includes(p.account))
      return logEvent(`   Skipped: account "${p.account}" isn't in your account filter`);
    for (const body of buildDiscordBodies(p, false, s.pingRoleId)) {
      if (!underRateCap()) return logEvent('   Skipped: more than 30 alerts in a minute');
      await postToDiscord(s.webhookUrl, body);
    }
    await logEvent('   ✅ Posted to Discord');
  });
}

// ---- Messages --------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'TV_FILL') {
    if (!fromTradovate(sender)) return false;
    handleFill(msg.payload, 'page');
    return false;
  }

  if (msg?.type === 'TV_STATS') {
    if (!fromTradovate(sender) || !msg.payload || typeof msg.payload !== 'object') return false;
    (async () => {
      const st = await getStatus();
      st.pages[`${sender.tab?.id}:${sender.frameId}`] = { ...msg.payload, at: Date.now(), url: (sender.url || '').replace(/[?#].*$/, '') };
      // Forget closed/stale pages (no report for 2 minutes)
      for (const [k, v] of Object.entries(st.pages)) if (Date.now() - v.at > 120000) delete st.pages[k];
      saveStatus();
    })();
    return false;
  }

  // Popup actions: only the extension's own pages may call these
  const fromPopup = sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
  if (msg?.type === 'DEEP_SET' && fromPopup) {
    setDeepCapture(!!msg.on).then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type === 'CLEAR_LOG' && fromPopup) {
    getStatus().then((st) => { st.events = []; st.sockets = []; saveStatus(); sendResponse({ ok: true }); });
    return true;
  }

  // Test button: only the extension's own popup/options page may trigger it
  if (msg?.type === 'TV_TEST') {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
    (async () => {
      try {
        const s = await getSettings();
        if (!s.webhookUrl) throw new Error('No webhook URL saved.');
        const base = {
          fillId: 'test', orderId: 'test', symbol: 'MESZ6', qty: 2,
          account: 'TEST', environment: 'DEMO', timestamp: new Date().toISOString()
        };
        const tests = [
          // Long: entry then trim
          { ...base, side: 'Buy', price: 6012.25, alerts: [{ kind: 'entry', qty: 2 }] },
          { ...base, side: 'Sell', price: 6018.5, alerts: [{ kind: 'trim', qty: 1, avgEntry: 6012.25, closedSide: 'LONG' }] },
          // Short: entry then trim
          { ...base, side: 'Sell', price: 6020.0, alerts: [{ kind: 'entry', qty: 2 }] },
          { ...base, side: 'Buy', price: 6014.75, alerts: [{ kind: 'trim', qty: 1, avgEntry: 6020.0, closedSide: 'SHORT' }] }
        ];
        // Ping the role on the first entry and the first trim only, so you can
        // confirm both alert types ping without notifying everyone four times.
        const pinged = new Set();
        for (const t of tests) {
          const kind = t.alerts[0].kind;
          const role = pinged.has(kind) ? '' : s.pingRoleId;
          pinged.add(kind);
          for (const body of buildDiscordBodies(t, true, role)) await postToDiscord(s.webhookUrl, body);
        }
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    })();
    return true; // async response
  }
});

// ---- Deep capture (chrome.debugger) -----------------------------------------
// Reads Tradovate's WebSocket messages from outside the page, including sockets
// opened inside workers, which the page hook can't reach. Chrome shows a
// "started debugging this browser" bar while it's on; that's expected.
// Read-only: it only listens to network events and never sends anything to Tradovate.
const TRADOVATE_URL_RE = /^https:\/\/([a-z0-9-]+\.)*tradovate\.com\//i;
const deepTargets = new Map(); // key -> { debuggee, parser, urls: Map }
let deepListenersReady = false;

const debuggeeKey = (d) => (d.tabId != null ? `tab:${d.tabId}` : `target:${d.targetId}`);

async function noteDeep() {
  const st = await getStatus();
  st.deep = { attached: [...deepTargets.keys()] };
  saveStatus();
}

function setupDeepListeners() {
  if (deepListenersReady || !chrome.debugger) return;
  deepListenersReady = true;

  chrome.debugger.onEvent.addListener((source, method, params) => {
    const t = deepTargets.get(debuggeeKey(source));
    if (!t) return;
    const sk = (source.sessionId || '') + ':';
    if (method === 'Target.attachedToTarget') {
      // A worker started inside the tab: listen to its network too
      const child = { ...t.debuggee, sessionId: params.sessionId };
      chrome.debugger.sendCommand(child, 'Network.enable').catch(() => {});
    } else if (method === 'Network.webSocketCreated') {
      t.urls.set(sk + params.requestId, params.url);
    } else if (method === 'Network.webSocketFrameReceived') {
      const r = params.response;
      if (r && r.opcode === 1) t.parser.handleRaw(r.payloadData, t.urls.get(sk + params.requestId) || '');
    }
  });

  chrome.debugger.onDetach.addListener((source, reason) => {
    if (deepTargets.delete(debuggeeKey(source))) {
      noteDeep();
      if (reason === 'canceled_by_user') {
        logEvent('⚠️ Deep capture stopped: the debugging bar was closed. Turn it off/on in the popup to resume.');
      }
    }
  });
}

async function attachDeep(debuggee, label) {
  const key = debuggeeKey(debuggee);
  if (!chrome.debugger || deepTargets.has(key)) return false;
  try {
    await chrome.debugger.attach(debuggee, '1.3');
  } catch (e) {
    logEvent(`⚠️ Deep capture couldn't attach to ${label}: ${String(e.message || e).slice(0, 80)}`);
    return false;
  }
  const parser = self.__awCreateTvParser((fill) => handleFill(fill, 'deep'));
  deepTargets.set(key, { debuggee, parser, urls: new Map() });
  await chrome.debugger.sendCommand(debuggee, 'Network.enable').catch(() => {});
  if (debuggee.tabId != null) {
    await chrome.debugger
      .sendCommand(debuggee, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
      .catch(() => {});
  }
  noteDeep();
  return true;
}

// Attach to Tradovate tabs and to any shared workers Tradovate runs.
async function attachAllTradovate({ reload }) {
  setupDeepListeners();
  const tabs = await chrome.tabs.query({ url: 'https://*.tradovate.com/*' });
  for (const tab of tabs) {
    const ok = await attachDeep({ tabId: tab.id }, 'the Tradovate tab');
    // Reload so the account/contract/position sync is captured from the start
    if (ok && reload) chrome.tabs.reload(tab.id).catch(() => {});
  }
  await attachSharedWorkers();
}

async function attachSharedWorkers() {
  if (!chrome.debugger) return;
  const targets = await chrome.debugger.getTargets().catch(() => []);
  for (const t of targets) {
    if (t.type === 'worker' && !t.tabId && TRADOVATE_URL_RE.test(t.url || '')) {
      if (await attachDeep({ targetId: t.id }, 'a Tradovate worker')) logEvent('Deep capture: attached to a Tradovate background worker');
    }
  }
}

async function detachAll() {
  for (const { debuggee } of deepTargets.values()) await chrome.debugger.detach(debuggee).catch(() => {});
  deepTargets.clear();
  noteDeep();
}

async function setDeepCapture(on) {
  await chrome.storage.local.set({ deepCapture: on });
  if (on) {
    await attachAllTradovate({ reload: true });
    logEvent('Deep capture ON. Tradovate tab reloaded so it can capture from the start.');
  } else {
    await detachAll();
    logEvent('Deep capture OFF');
  }
}

// Attach as early as possible when a Tradovate tab starts loading
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'loading' || !TRADOVATE_URL_RE.test(tab.url || '')) return;
  const { deepCapture } = await getSettings();
  if (!deepCapture) return;
  setupDeepListeners();
  await attachDeep({ tabId }, 'the Tradovate tab');
  setTimeout(attachSharedWorkers, 4000); // pick up workers the app starts after load
});

// Service worker (re)start: resume Deep capture if it was on
(async () => {
  const { deepCapture } = await getSettings();
  if (deepCapture && chrome.debugger) await attachAllTradovate({ reload: false });
})();
