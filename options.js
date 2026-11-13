const DEFAULTS = {
  webhookUrl: '', enabled: true, includeDemo: true, accountFilter: '',
  pingRoleId: '', deepCapture: false
};
const ROLE_ID_RE = /^\d{17,20}$/;
const WEBHOOK_RE = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const $ = (id) => document.getElementById(id);

function status(text, ok = true) {
  $('status').textContent = text;
  $('status').className = ok ? 'ok' : 'err';
}

chrome.storage.local.get(DEFAULTS).then((s) => {
  $('webhookUrl').value = s.webhookUrl;
  $('enabled').checked = s.enabled;
  $('includeDemo').checked = s.includeDemo;
  $('accountFilter').value = s.accountFilter;
  $('pingRoleId').value = s.pingRoleId;
  $('deepCapture').checked = s.deepCapture;
});

$('save').addEventListener('click', async () => {
  const webhookUrl = $('webhookUrl').value.trim();
  if (webhookUrl && !WEBHOOK_RE.test(webhookUrl)) {
    return status('That does not look like a Discord webhook URL.', false);
  }
  const pingRoleId = $('pingRoleId').value.trim();
  if (pingRoleId && !ROLE_ID_RE.test(pingRoleId)) {
    return status('Role ID should be 17–20 digits (no @ or <>).', false);
  }
  await chrome.storage.local.set({
    pingRoleId,
    webhookUrl,
    enabled: $('enabled').checked,
    includeDemo: $('includeDemo').checked,
    accountFilter: $('accountFilter').value.trim()
  });
  status('Saved.');
});

$('test').addEventListener('click', async () => {
  status('Sending…');
  const res = await chrome.runtime.sendMessage({ type: 'TV_TEST' });
  res?.ok ? status('Test message sent — check Discord.') : status(res?.error || 'Failed.', false);
});

// ---- Status panel -----------------------------------------------------------
const el = (tag, text) => { const e = document.createElement(tag); e.textContent = text; return e; };
let lastStatus = null;

function diagnose(st) {
  const pages = Object.values(st.pages || {});
  const tv = pages.reduce((n, p) => n + (p.tvFrames || 0), 0);
  const fills = pages.reduce((n, p) => n + (p.fills || 0), 0);
  const tradingSocket = (st.sockets || []).some((s) => !/\/\/md[.-]/i.test(s) && /tradovateapi|tradovate\.com|ninjatrader/i.test(s));
  const deepOn = (st.deep?.attached || []).length > 0;
  if (deepOn) return '🟢 Deep capture is on and listening.';
  if (!pages.length) return '🔴 Not running on Tradovate. Open/refresh trader.tradovate.com, then reopen this popup.';
  if (tv > 0) return fills > 0
    ? `🟢 Reading Tradovate. ${fills} fill(s) seen since the page loaded.`
    : '🟢 Reading Tradovate. Waiting for a fill.';
  if (tradingSocket) return '🟠 Tradovate is connected, but its messages aren\'t reaching the page hook. Turn on Deep capture below.';
  return '🟠 Running on Tradovate but no trading connection seen yet. Log in, wait a few seconds, then reopen this popup.';
}

function render(st) {
  lastStatus = st;
  $('diagnosis').textContent = diagnose(st);
  const pages = $('pages'); pages.replaceChildren();
  for (const p of Object.values(st.pages || {})) {
    pages.append(el('div', `Page hook (${p.frame}): ${p.tvFrames || 0} Tradovate msgs, ${p.fills || 0} fills, workers: ${(p.workers || 0) + (p.sharedWorkers || 0)}`));
  }
  const sockets = $('sockets'); sockets.replaceChildren();
  if (st.sockets?.length) {
    sockets.append(el('div', 'Connections seen:'));
    for (const s of st.sockets.slice(0, 6)) sockets.append(el('div', '  • ' + s.replace(/^wss?:\/\//, '')));
  }
  $('events').textContent = (st.events || []).join('\n') || 'No activity yet.';
}

async function refresh() {
  const { status } = await chrome.storage.session.get('status');
  render(status || { pages: {}, sockets: [], events: [], deep: {} });
}
refresh();
setInterval(refresh, 1500);

$('deepCapture').addEventListener('change', async (e) => {
  const on = e.target.checked;
  const res = await chrome.runtime.sendMessage({ type: 'DEEP_SET', on });
  if (!res?.ok) { e.target.checked = false; return status(res?.error || 'Could not change Deep capture.', false); }
  status(on ? 'Deep capture on. Tradovate tab reloaded.' : 'Deep capture off.');
});

$('clearLog').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_LOG' });
  refresh();
});

// Copies status only. Never includes the webhook URL.
$('copyDiag').addEventListener('click', async () => {
  const s = await chrome.storage.local.get(DEFAULTS);
  const report = {
    version: chrome.runtime.getManifest().version,
    settings: { enabled: s.enabled, includeDemo: s.includeDemo, accountFilterSet: !!s.accountFilter, webhookSaved: !!s.webhookUrl, deepCapture: s.deepCapture },
    status: lastStatus
  };
  await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
  status('Diagnostics copied. Share them with whoever is helping you troubleshoot.');
});
