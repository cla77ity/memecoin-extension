/* SolSniper background service worker (MV3). */
importScripts('engine.js');

const S = self.SolSniper;
const TIMEOUT_MS = 1500;
const CACHE_TTL_MS = 12_000;
const SIGNAL_DEDUPE_MS = 10 * 60_000;
const LOG_LIMIT = 100;
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';

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

// ---------------------------------------------------------------- http helpers
async function fetchJson(url, init = {}, timeout = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, headers: { accept: 'application/json', ...(init.headers || {}) } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${new URL(url).hostname}`);
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Timeout ${timeout}ms ${new URL(url).hostname}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function rpcEndpoint() {
  if (settings.rpcUrl) return settings.rpcUrl.trim();
  if (settings.heliusApiKey) return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(settings.heliusApiKey.trim())}`;
  return PUBLIC_RPC;
}

async function rpcBatch(calls) {
  const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c.method, params: c.params }));
  const res = await fetchJson(rpcEndpoint(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const arr = Array.isArray(res) ? res : [res];
  const out = new Array(calls.length).fill(null);
  for (const r of arr) {
    if (r && typeof r.id === 'number') out[r.id] = r.error ? { error: r.error } : { result: r.result };
  }
  return out;
}

// ---------------------------------------------------------------- data sources
async function dexByToken(mint) {
  const j = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
  return (j.pairs || []).filter((p) => p.chainId === 'solana');
}

async function dexByPair(pair) {
  const j = await fetchJson(`https://api.dexscreener.com/latest/dex/pairs/solana/${pair}`);
  return j.pair || (j.pairs && j.pairs[0]) || null;
}

function pickBestPair(pairs, mint) {
  const own = pairs.filter((p) => p.baseToken && p.baseToken.address === mint);
  return own.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))[0] || null;
}

const rugSummary = (mint) => fetchJson(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`);
const rugReport = (mint) => fetchJson(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`);

async function onchain(mint) {
  const [acc, largest] = await rpcBatch([
    { method: 'getAccountInfo', params: [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }] },
    { method: 'getTokenLargestAccounts', params: [mint, { commitment: 'confirmed' }] },
  ]);
  const info = acc && acc.result && acc.result.value && acc.result.value.data && acc.result.value.data.parsed
    ? acc.result.value.data.parsed.info : null;
  const out = {
    mintAuthority: info ? info.mintAuthority != null : null,
    freezeAuthority: info ? info.freezeAuthority != null : null,
    supplyRaw: info ? Number(info.supply) : null,
    decimals: info ? info.decimals : null,
    holders: [],
  };
  const accounts = (largest && largest.result && largest.result.value) || [];
  if (accounts.length) {
    out.holders = accounts.map((a) => ({ address: a.address, amountRaw: Number(a.amount), owner: null }));
    try {
      const [owners] = await rpcBatch([
        { method: 'getMultipleAccounts', params: [accounts.map((a) => a.address), { encoding: 'jsonParsed' }] },
      ]);
      const vals = (owners && owners.result && owners.result.value) || [];
      vals.forEach((v, i) => {
        const o = v && v.data && v.data.parsed && v.data.parsed.info && v.data.parsed.info.owner;
        if (o) out.holders[i].owner = o;
      });
    } catch (e) {
      out.ownersError = String(e.message || e);
    }
  }
  return out;
}

async function heliusAsset(mint) {
  if (!settings.heliusApiKey || settings.rpcUrl) return null;
  const [r] = await rpcBatch([{ method: 'getAsset', params: { id: mint } }]);
  return r && r.result ? r.result : null;
}

// ---------------------------------------------------------------- analysis pipeline
const cache = new Map();    // mint -> { at, data }
const inflight = new Map(); // key -> Promise

async function resolveTarget(address, kind) {
  if (kind === 'pair') {
    const pair = await dexByPair(address).catch(() => null);
    if (pair && pair.baseToken) return { mint: pair.baseToken.address, viewedPair: pair };
    return { mint: address, viewedPair: null };
  }
  if (kind === 'mint') return { mint: address, viewedPair: null };
  // unknown: try as mint first, then as pair
  const pairs = await dexByToken(address).catch(() => []);
  if (pairs.some((p) => p.baseToken && p.baseToken.address === address)) return { mint: address, viewedPair: null, pairs };
  const pair = await dexByPair(address).catch(() => null);
  if (pair && pair.baseToken) return { mint: pair.baseToken.address, viewedPair: pair };
  return { mint: address, viewedPair: null, pairs };
}

async function analyzeToken(address, kind = 'unknown', force = false) {
  await settingsReady;
  if (!S.isBase58Address(address)) throw new Error('Invalid address');
  const key = `${kind}:${address}`;
  if (!force) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
    if (inflight.has(key)) return inflight.get(key);
  }
  const p = (async () => {
    const target = await resolveTarget(address, kind);
    const { mint } = target;
    const [pairsR, sumR, repR, chainR, assetR] = await Promise.allSettled([
      target.pairs ? Promise.resolve(target.pairs) : dexByToken(mint),
      rugSummary(mint),
      rugReport(mint),
      onchain(mint),
      heliusAsset(mint),
    ]);
    const data = mergeData(mint, target.viewedPair, pairsR, sumR, repR, chainR, assetR);
    const result = withVerdict(data);
    cache.set(key, { at: Date.now(), data: result });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return result;
  })();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}

function mergeData(mint, viewedPair, pairsR, sumR, repR, chainR, assetR) {
  const errors = {};
  const val = (r, name) => {
    if (r.status === 'fulfilled') return r.value;
    errors[name] = String((r.reason && r.reason.message) || r.reason);
    return null;
  };
  const pairs = val(pairsR, 'dexscreener') || [];
  const summary = val(sumR, 'rugcheck');
  const report = val(repR, 'rugcheckReport');
  const chain = val(chainR, 'rpc');
  const asset = val(assetR, 'helius');

  const pair = (viewedPair && viewedPair.baseToken && viewedPair.baseToken.address === mint ? viewedPair : null) || pickBestPair(pairs, mint);
  const info = (pair && pair.info) || {};
  const socials = {};
  for (const s of info.socials || []) {
    const type = (s.type || s.platform || '').toLowerCase();
    if ((type === 'twitter' || type === 'x') && !socials.twitter) socials.twitter = s.url || s.handle;
    if (type === 'telegram' && !socials.telegram) socials.telegram = s.url || s.handle;
  }
  if (info.websites && info.websites[0]) socials.website = info.websites[0].url;

  const priceUsd = S.num(pair && pair.priceUsd);
  const priceNative = S.num(pair && pair.priceNative);
  const quoteIsSol = pair && pair.quoteToken && pair.quoteToken.address === S.WSOL;
  const dexId = pair ? pair.dexId : null;
  const isPumpMint = mint.endsWith('pump');
  const isBondingCurve = dexId === 'pumpfun' || (!pair && isPumpMint && !(report && report.markets && report.markets.length));

  // --- authorities (on-chain first, RugCheck report fallback)
  let mintAuthority = chain ? chain.mintAuthority : null;
  let freezeAuthority = chain ? chain.freezeAuthority : null;
  if (mintAuthority === null && report && 'mintAuthority' in report) mintAuthority = report.mintAuthority != null;
  if (freezeAuthority === null && report && 'freezeAuthority' in report) freezeAuthority = report.freezeAuthority != null;
  if (mintAuthority === null && asset && asset.token_info) mintAuthority = !!asset.token_info.mint_authority;
  if (freezeAuthority === null && asset && asset.token_info) freezeAuthority = !!asset.token_info.freeze_authority;

  // --- LP burned / locked %
  let lpBurnedPct = S.num(summary && summary.lpLockedPct);
  if (lpBurnedPct === null && report && Array.isArray(report.markets)) {
    const vals = report.markets.map((m) => S.num(m.lp && m.lp.lpLockedPct)).filter((v) => v !== null);
    if (vals.length) lpBurnedPct = Math.max(...vals);
  }

  // --- holder concentration (exclude pools / AMM authorities / burn)
  const exclude = new Set(S.KNOWN_POOL_OWNERS);
  for (const p of pairs) if (p.pairAddress) exclude.add(p.pairAddress);
  if (pair && pair.pairAddress) exclude.add(pair.pairAddress);
  if (report && report.knownAccounts) {
    for (const [addr, k] of Object.entries(report.knownAccounts)) if (k && k.type === 'AMM') exclude.add(addr);
  }
  if (report && Array.isArray(report.markets)) {
    for (const m of report.markets) {
      for (const f of ['pubkey', 'liquidityA', 'liquidityB', 'liquidityAAccount', 'liquidityBAccount']) if (m[f]) exclude.add(m[f]);
    }
  }
  const supplyRaw = (chain && chain.supplyRaw) || (report && report.token && S.num(report.token.supply)) || null;
  let top10Pct = null;
  if (chain && chain.holders.length && supplyRaw && !chain.ownersError) {
    const real = chain.holders.filter((h) => !exclude.has(h.address) && !exclude.has(h.owner));
    top10Pct = (real.slice(0, 10).reduce((s, h) => s + h.amountRaw, 0) / supplyRaw) * 100;
  } else if (report && Array.isArray(report.topHolders) && report.topHolders.length) {
    const real = report.topHolders.filter((h) => !exclude.has(h.address) && !exclude.has(h.owner));
    top10Pct = real.slice(0, 10).reduce((s, h) => s + (S.num(h.pct) || 0), 0);
  }

  // --- dev wallet
  let devPct = null;
  const creator = report && report.creator;
  if (creator) {
    const viaHolders = report.topHolders && report.topHolders.find((h) => h.owner === creator || h.address === creator);
    if (viaHolders) devPct = S.num(viaHolders.pct);
    else if (S.num(report.creatorBalance) !== null && supplyRaw) devPct = (report.creatorBalance / supplyRaw) * 100;
    if (devPct !== null && (devPct < 0 || devPct > 100)) devPct = null;
  }

  const rugRisks = ((summary && summary.risks) || (report && report.risks) || []).map((r) => ({
    name: r.name, level: r.level, value: r.value || '', description: r.description || '',
  }));

  const meta = (asset && asset.content && asset.content.metadata) || {};
  return {
    mint,
    symbol: (pair && pair.baseToken.symbol) || meta.symbol || (report && report.tokenMeta && report.tokenMeta.symbol) || '???',
    name: (pair && pair.baseToken.name) || meta.name || (report && report.tokenMeta && report.tokenMeta.name) || '',
    imageUrl: info.imageUrl || null,
    pairAddress: pair ? pair.pairAddress : null,
    dexId,
    isBondingCurve,
    priceUsd,
    solUsd: quoteIsSol && priceUsd && priceNative ? priceUsd / priceNative : null,
    marketCap: S.num(pair && (pair.marketCap || pair.fdv)),
    liquidityUsd: S.num(pair && pair.liquidity && pair.liquidity.usd),
    vol5m: S.num(pair && pair.volume && pair.volume.m5),
    vol1h: S.num(pair && pair.volume && pair.volume.h1),
    change5m: S.num(pair && pair.priceChange && pair.priceChange.m5),
    txns5m: pair && pair.txns && pair.txns.m5 ? pair.txns.m5 : null,
    pairCreatedAt: pair ? pair.pairCreatedAt || null : null,
    socials,
    mintAuthority,
    freezeAuthority,
    lpBurnedPct,
    top10Pct,
    devPct,
    rugScore: summary ? S.num(summary.score_normalised ?? summary.score) : null,
    rugRisks,
    totalHolders: report ? S.num(report.totalHolders) : null,
    sources: {
      dexscreener: !errors.dexscreener && !!pair,
      rugcheck: !errors.rugcheck,
      rpc: !errors.rpc && !(chain && chain.ownersError),
    },
    errors,
    links: S.links(mint, pair ? pair.pairAddress : null),
    fetchedAt: Date.now(),
  };
}

function withVerdict(data) {
  const filter = S.applySignalFilter(data, settings);
  return { token: data, evaluation: filter.evaluation, badge: filter.badge, filter: { approved: filter.approved, reasons: filter.reasons } };
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
      title: `🎯 $${entry.symbol} — score ${entry.score}/100`,
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
