/* SolSniper background service worker (MV3). */
importScripts('engine.js', 'analyzer.js');

const S = self.SolSniper;
const TIMEOUT_MS = 1500;
const CACHE_TTL_MS = 12_000;
const SIGNAL_DEDUPE_MS = 10 * 60_000;
const LOG_LIMIT = 100;

// ---------------------------------------------------------------- settings
let settings = { ...S.DEFAULT_SETTINGS };
const settingsReady = loadSettings();

async function loadSettings() {
  try {
    const { settings: stored } = await chrome.storage.local.get('settings');
    settings = { ...S.DEFAULT_SETTINGS, ...(stored || {}) };
  } catch (e) {
    console.warn('[SolSniper] settings load failed', e);
  }
  return settings;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const prev = settings;
  settings = { ...S.DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
  if (prev.wsUrl !== settings.wsUrl || prev.wsEnabled !== settings.wsEnabled) {
    disconnectWS();
    connectWS();
  }
  if (prev.heliusApiKey !== settings.heliusApiKey || prev.rpcUrl !== settings.rpcUrl) cache.clear();
});

// ---------------------------------------------------------------- analysis (shared with the web app)
const analyzer = self.SolSniperAnalyzer.createAnalyzer({ getSettings: () => settings, timeoutMs: TIMEOUT_MS, cacheTtlMs: CACHE_TTL_MS });
const rpcEndpoint = analyzer.rpcEndpoint;
const cache = { clear: analyzer.clearCache };

async function analyzeToken(address, kind = 'unknown', force = false) {
  await settingsReady;
  return analyzer.analyzeToken(address, kind, force);
}

// ---------------------------------------------------------------- signals
async function getSession(key, fallback) {
  try {
    const area = chrome.storage.session || chrome.storage.local;
    const r = await area.get(key);
    return r[key] ?? fallback;
  } catch (_) {
    return fallback;
  }
}
async function setSession(key, value) {
  try {
    await (chrome.storage.session || chrome.storage.local).set({ [key]: value });
  } catch (_) { /* ignore */ }
}

async function processSignal(address, meta = {}, { bypassDedupe = false } = {}) {
  const seen = await getSession('seenSignals', {});
  const now = Date.now();
  for (const [k, t] of Object.entries(seen)) if (now - t > SIGNAL_DEDUPE_MS) delete seen[k];
  if (!bypassDedupe && seen[address]) return null;
  seen[address] = now;
  await setSession('seenSignals', seen);

  let entry;
  try {
    const r = await analyzeToken(address, meta.kind || 'unknown', true);
    const t = r.token;
    entry = {
      id: `${t.mint}:${now}`,
      ts: now,
      mint: t.mint,
      symbol: t.symbol,
      name: t.name,
      score: r.evaluation.score,
      badge: r.badge.level,
      approved: r.filter.approved,
      reasons: r.filter.reasons,
      marketCap: t.marketCap,
      vol5m: t.vol5m,
      liquidityUsd: t.liquidityUsd,
      top10Pct: t.top10Pct,
      channel: String(meta.channel || 'signal').slice(0, 80),
      text: String(meta.text || '').slice(0, 280),
      links: t.links,
    };
  } catch (e) {
    entry = {
      id: `${address}:${now}`, ts: now, mint: address, symbol: '???', name: '', score: 0, badge: 'DANGER',
      approved: false, reasons: [`Analysis failed: ${e.message || e}`], channel: String(meta.channel || 'signal').slice(0, 80),
      text: String(meta.text || '').slice(0, 280), links: S.links(address, null),
    };
  }

  const { signalLog = [] } = await chrome.storage.local.get('signalLog');
  signalLog.unshift(entry);
  await chrome.storage.local.set({ signalLog: signalLog.slice(0, LOG_LIMIT) });
  chrome.runtime.sendMessage({ type: 'SIGNAL_LOGGED', entry }).catch(() => {});

  if (entry.approved && settings.notifyEnabled) await notify(entry);
  return entry;
}

async function notify(entry) {
  const id = `sig:${entry.id}`;
  try {
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: `SIGNAL · $${entry.symbol} — score ${entry.score}/100`,
      message: `MC ${S.fmtUsd(entry.marketCap)} · Vol5m ${S.fmtUsd(entry.vol5m)} · Top10 ${S.fmtPct(entry.top10Pct)}`,
      contextMessage: entry.channel,
      buttons: [{ title: 'Open in Photon' }, { title: 'Open in DEXScreener' }],
      priority: 2,
      requireInteraction: false,
    });
    const map = await getSession('notifLinks', {});
    map[id] = entry.links;
    const keys = Object.keys(map);
    if (keys.length > 50) delete map[keys[0]];
    await setSession('notifLinks', map);
  } catch (e) {
    console.warn('[SolSniper] notification failed', e); // e.g. Kiwi / unsupported platform
  }
}

async function openFromNotification(id, which) {
  const map = await getSession('notifLinks', {});
  const l = map[id];
  if (!l) return;
  await chrome.tabs.create({ url: which === 0 ? l.photon : l.dexscreener });
  chrome.notifications.clear(id);
}
chrome.notifications.onClicked.addListener((id) => openFromNotification(id, 1));
chrome.notifications.onButtonClicked.addListener((id, idx) => openFromNotification(id, idx));

// ---------------------------------------------------------------- websocket
let ws = null;
let wsState = 'disconnected';
let wsLastError = '';
let reconnectDelay = 1000;
let reconnectTimer = null;
let pingTimer = null;

function setWsState(state, err) {
  wsState = state;
  if (err !== undefined) wsLastError = err;
  chrome.runtime.sendMessage({ type: 'WS_STATE', state, error: wsLastError }).catch(() => {});
}

async function connectWS() {
  await settingsReady;
  if (!settings.wsEnabled || !settings.wsUrl) return setWsState('disabled');
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  try {
    ws = new WebSocket(settings.wsUrl);
  } catch (e) {
    setWsState('error', String(e.message || e));
    return scheduleReconnect();
  }
  setWsState('connecting');
  const sock = ws;
  sock.onopen = () => {
    reconnectDelay = 1000;
    setWsState('connected', '');
    sock.send(JSON.stringify({ type: 'hello', client: 'solsniper-extension', version: chrome.runtime.getManifest().version }));
    clearInterval(pingTimer);
    // Activity every 20s keeps the MV3 service worker alive while the socket is open (Chrome 116+).
    pingTimer = setInterval(() => {
      if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    }, 20_000);
  };
  sock.onmessage = (ev) => handleWsMessage(ev.data).catch((e) => console.warn('[SolSniper] ws msg error', e));
  sock.onerror = () => setWsState('error', `Cannot reach ${settings.wsUrl}`);
  sock.onclose = () => {
    clearInterval(pingTimer);
    if (ws === sock) ws = null;
    if (wsState !== 'error') setWsState('disconnected');
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (!settings.wsEnabled) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectWS, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
}

function disconnectWS() {
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  if (ws) {
    const s = ws;
    ws = null;
    s.onclose = null;
    try { s.close(); } catch (_) { /* ignore */ }
  }
  setWsState(settings.wsEnabled ? 'disconnected' : 'disabled');
}

async function handleWsMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (_) {
    msg = { type: 'signal', text: String(raw) };
  }
  if (!msg || msg.type !== 'signal') return;
  let addrs = [];
  if (Array.isArray(msg.mints)) addrs = msg.mints;
  else if (msg.mint) addrs = [msg.mint];
  else if (msg.text) addrs = S.extractAddresses(msg.text, 3);
  addrs = addrs.filter(S.isBase58Address).slice(0, 3);
  for (const a of addrs) {
    await processSignal(a, { channel: msg.channel || msg.source, text: msg.text, kind: msg.kind });
  }
}

// ---------------------------------------------------------------- lifecycle
chrome.runtime.onInstalled.addListener(async () => {
  const { settings: stored } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...S.DEFAULT_SETTINGS, ...(stored || {}) } });
  chrome.alarms.create('ws-watchdog', { periodInMinutes: 0.5 });
  connectWS();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('ws-watchdog', { periodInMinutes: 0.5 });
  connectWS();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'ws-watchdog') connectWS();
});
connectWS();

// ---------------------------------------------------------------- messaging
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handlers = {
    ANALYZE: async () => ({ ok: true, ...(await analyzeToken(msg.address, msg.kind, !!msg.force)) }),
    GET_STATUS: async () => ({ ok: true, ws: { state: wsState, error: wsLastError, url: settings.wsUrl }, rpc: rpcEndpoint().replace(/api-key=[^&]+/, 'api-key=***') }),
    GET_LOG: async () => {
      const { signalLog = [] } = await chrome.storage.local.get('signalLog');
      return { ok: true, log: signalLog };
    },
    CLEAR_LOG: async () => {
      await chrome.storage.local.set({ signalLog: [] });
      return { ok: true };
    },
    TEST_SIGNAL: async () => {
      if (!S.isBase58Address(msg.address)) throw new Error('Invalid address');
      const entry = await processSignal(msg.address, { channel: 'Manual test', text: msg.address }, { bypassDedupe: true });
      return { ok: true, entry };
    },
    WS_RECONNECT: async () => {
      disconnectWS();
      reconnectDelay = 1000;
      await connectWS();
      return { ok: true };
    },
  };
  const h = handlers[msg && msg.type];
  if (!h) return false;
  h().then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // async response
});
