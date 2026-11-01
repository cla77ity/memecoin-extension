/**
 * SolSniper live scanner — discovers every new Solana memecoin launch and alerts only on low-risk ones.
 * Runs in the browser (web app) and in Node 22+ (bot.js). Requires engine.js + analyzer.js.
 *
 * Pipeline (cheap → expensive, to stay inside free API limits):
 *   1. Discovery  PumpPortal WebSocket: every pump.fun create + every migration to an AMM;
 *                 DexScreener latest token profiles (non-pump launches, teams that set up socials).
 *   2. Prefilter  DexScreener batch endpoint, 30 tokens per request: 5m volume / liquidity / MC.
 *   3. Full check analyzer.analyzeToken (RugCheck + Helius) only for prefilter candidates, rate-capped.
 *   4. Alert      applySignalFilter approved AND badge != DANGER → onEvent('alert').
 */
(function (root) {
  'use strict';
  const S = root.SolSniper;
  const PUMPPORTAL_WS = 'wss://pumpportal.fun/api/data';
  const DEX_BATCH = 'https://api.dexscreener.com/tokens/v1/solana/';
  const DEX_PROFILES = 'https://api.dexscreener.com/token-profiles/latest/v1';

  const LIVE_DEFAULTS = {
    minLiqUsd: 10000,       // prefilter: AMM liquidity floor (bonding-curve tokens are exempt)
    watchMinutes: 30,       // how long a fresh token stays on the watchlist
    maxChecksPerMin: 6,     // full RugCheck + RPC analyses per minute (protects free Helius credits)
    liveMigrationsOnly: false,
  };
  const MIN_AGE_MS = 45_000;        // DexScreener needs a moment to index a brand-new token
  const PREFILTER_EVERY_MS = 25_000; // per-token prefilter cadence
  const RECHECK_REJECTED_MS = 180_000;
  const MAX_WATCH = 3000;

  function createScanner({ analyzer, getSettings, fetchImpl, WebSocketImpl, onEvent = () => {}, log = () => {} }) {
    const doFetch = fetchImpl || ((u, i) => fetch(u, i));
    const WS = WebSocketImpl || root.WebSocket;
    const watch = new Map();
    const checking = new Set();
    const stats = { seen: 0, prefiltered: 0, checked: 0, alerts: 0, startedAt: 0 };
    let ws = null;
    let wsState = 'off';
    let wsDelay = 1000;
    let running = false;
    let busy = false;
    let timers = [];
    let checkTimes = [];

    const cfg = () => ({ ...S.DEFAULT_SETTINGS, ...LIVE_DEFAULTS, ...getSettings() });
    const emit = (type, data) => { try { onEvent(type, data); } catch (e) { log('onEvent error', e); } };

    // ------------------------------------------------------------ watchlist
    function add(mint, meta) {
      if (!S.isBase58Address(mint)) return;
      let t = watch.get(mint);
      if (!t) {
        if (cfg().liveMigrationsOnly && meta.source === 'pump') return;
        t = {
          mint, symbol: meta.symbol || '', name: meta.name || '', source: meta.source,
          firstSeen: Date.now(), lastPrefilter: 0, lastFull: 0, status: 'new', metrics: null, reasons: [], score: null, badge: null,
        };
        watch.set(mint, t);
        stats.seen += 1;
        if (watch.size > MAX_WATCH) prune(true);
        emit('token', t);
        return;
      }
      if (meta.symbol && !t.symbol) t.symbol = meta.symbol;
      if (meta.source === 'migration' && t.source !== 'migration') {
        // graduated to an AMM: re-evaluate right away, this is the most interesting moment
        t.source = 'migration';
        t.firstSeen = Date.now();
        t.lastPrefilter = 0;
        if (t.status === 'rejected') t.status = 'watch';
        emit('update', t);
      }
    }

    function prune(force = false) {
      const now = Date.now();
      const maxAge = cfg().watchMinutes * 60_000;
      for (const [m, t] of watch) {
        const ttl = t.status === 'alerted' ? 6 * 3600_000 : maxAge;
        if (now - t.firstSeen > ttl) watch.delete(m);
      }
      if (force && watch.size > MAX_WATCH) {
        const old = [...watch.values()].filter((t) => t.status !== 'alerted').sort((a, b) => a.firstSeen - b.firstSeen);
        for (const t of old.slice(0, watch.size - Math.floor(MAX_WATCH * 0.8))) watch.delete(t.mint);
      }
    }

    // ------------------------------------------------------------ discovery: PumpPortal stream
    function connect() {
      if (!running) return;
      if (!WS) { setState('unsupported'); return; }
      let sock;
      try { sock = new WS(PUMPPORTAL_WS); } catch (e) { setState('error'); reconnect(); return; }
      ws = sock;
      setState('connecting');
      sock.onopen = () => {
        wsDelay = 1000;
        setState('live');
        sock.send(JSON.stringify({ method: 'subscribeNewToken' }));
        sock.send(JSON.stringify({ method: 'subscribeMigration' }));
      };
      sock.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (_) { return; }
        if (!m || typeof m.mint !== 'string') return;
        if (m.txType === 'migrate' || m.txType === 'migration') add(m.mint, { source: 'migration' });
        else if (m.txType === 'create') add(m.mint, { source: 'pump', symbol: m.symbol, name: m.name });
      };
      sock.onerror = () => {};
      sock.onclose = () => {
        if (ws !== sock) return;
        ws = null;
        setState(running ? 'reconnecting' : 'off');
        reconnect();
      };
    }
    function reconnect() {
      if (!running) return;
      timers.push(setTimeout(connect, wsDelay));
      wsDelay = Math.min(wsDelay * 2, 30_000);
    }
    function setState(s) {
      wsState = s;
      emit('status', status());
    }

    // ------------------------------------------------------------ http
    async function fetchJson(url, timeout = 5000) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        const res = await doFetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    }

    async function pollProfiles() {
      try {
        const arr = await fetchJson(DEX_PROFILES);
        for (const p of Array.isArray(arr) ? arr : []) {
          if (p && p.chainId === 'solana') add(p.tokenAddress, { source: 'profile' });
        }
      } catch (e) {
        log('profiles:', e.message || e);
      }
    }

    // ------------------------------------------------------------ prefilter (batched)
    async function prefilter() {
      if (busy || !running) return;
      busy = true;
      try {
        prune();
        const c = cfg();
        const now = Date.now();
        const due = [...watch.values()]
          .filter((t) => t.status !== 'alerted' && !checking.has(t.mint) && now - t.firstSeen > MIN_AGE_MS && now - t.lastPrefilter > PREFILTER_EVERY_MS)
          .sort((a, b) => (b.source === 'migration') - (a.source === 'migration') || a.lastPrefilter - b.lastPrefilter)
          .slice(0, 300);
        for (let i = 0; i < due.length && running; i += 30) {
          const chunk = due.slice(i, i + 30);
          let pairs;
          try {
            pairs = await fetchJson(DEX_BATCH + chunk.map((t) => t.mint).join(','));
          } catch (e) {
            log('dex batch:', e.message || e);
            break; // rate-limited or offline: try again next tick
          }
          const best = new Map();
          for (const p of Array.isArray(pairs) ? pairs : []) {
            const m = p && p.baseToken && p.baseToken.address;
            if (!m) continue;
            const cur = best.get(m);
            if (!cur || ((p.liquidity && p.liquidity.usd) || 0) > ((cur.liquidity && cur.liquidity.usd) || 0)) best.set(m, p);
          }
          const ts = Date.now();
          for (const t of chunk) {
            t.lastPrefilter = ts;
            const p = best.get(t.mint);
            stats.prefiltered += 1;
            if (!p) { if (t.status === 'new') t.status = 'watch'; continue; }
            t.symbol = t.symbol || p.baseToken.symbol || '';
            t.name = t.name || p.baseToken.name || '';
            t.metrics = {
              mc: S.num(p.marketCap || p.fdv),
              vol5m: S.num(p.volume && p.volume.m5),
              liq: S.num(p.liquidity && p.liquidity.usd),
              change5m: S.num(p.priceChange && p.priceChange.m5),
              dexId: p.dexId || '',
              pairAddress: p.pairAddress || '',
            };
            const hot = (t.metrics.vol5m || 0) >= c.minVol5mUsd
              && (p.dexId === 'pumpfun' || (t.metrics.liq || 0) >= c.minLiqUsd);
            if (hot && (t.status !== 'rejected' || ts - t.lastFull > RECHECK_REJECTED_MS)) t.status = 'candidate';
            else if (t.status === 'new') t.status = 'watch';
            emit('update', t);
          }
        }
        fullChecks();
      } finally {
        busy = false;
      }
    }

    // ------------------------------------------------------------ full analysis (rate-capped)
    function fullChecks() {
      const c = cfg();
      const now = Date.now();
      checkTimes = checkTimes.filter((x) => now - x < 60_000);
      const cands = [...watch.values()]
        .filter((t) => t.status === 'candidate' && !checking.has(t.mint))
        .sort((a, b) => ((b.metrics && b.metrics.vol5m) || 0) - ((a.metrics && a.metrics.vol5m) || 0));
      for (const t of cands) {
        if (checkTimes.length >= c.maxChecksPerMin || checking.size >= 2) break;
        checkTimes.push(Date.now());
        checking.add(t.mint);
        t.status = 'checking';
        emit('update', t);
        analyzer.analyzeToken(t.mint, 'mint', true).then((r) => {
          stats.checked += 1;
          t.lastFull = Date.now();
          t.score = r.evaluation.score;
          t.badge = r.badge.level;
          t.symbol = r.token.symbol && r.token.symbol !== '???' ? r.token.symbol : t.symbol;
          const ok = r.filter.approved && r.badge.level !== 'DANGER';
          t.reasons = ok ? [] : (r.filter.reasons.length ? r.filter.reasons : r.badge.reasons);
          t.status = ok ? 'alerted' : 'rejected';
          if (ok) {
            stats.alerts += 1;
            emit('alert', { item: t, result: r });
          }
          emit('update', t);
        }).catch((e) => {
          t.lastFull = Date.now();
          t.status = 'watch';
          t.reasons = [String(e.message || e)];
          log('check:', e.message || e);
          emit('update', t);
        }).finally(() => checking.delete(t.mint));
      }
    }

    // ------------------------------------------------------------ public api
    function status() {
      let candidates = 0;
      let alerted = 0;
      for (const t of watch.values()) {
        if (t.status === 'candidate' || t.status === 'checking') candidates += 1;
        if (t.status === 'alerted') alerted += 1;
      }
      return { stream: wsState, running, watching: watch.size, candidates, alerted, checkingNow: checking.size, ...stats };
    }

    function start() {
      if (running) return;
      running = true;
      stats.startedAt = Date.now();
      connect();
      pollProfiles();
      timers.push(setInterval(prefilter, 10_000));
      timers.push(setInterval(pollProfiles, 60_000));
      emit('status', status());
    }

    function stop() {
      running = false;
      for (const t of timers) { clearTimeout(t); clearInterval(t); }
      timers = [];
      if (ws) { const s = ws; ws = null; s.onclose = null; try { s.close(); } catch (_) { /* ignore */ } }
      setState('off');
    }

    /** Ensure the stream is up (e.g. after iOS unfreezes the page). */
    function wake() {
      if (running && !ws) { wsDelay = 1000; connect(); }
      if (running) prefilter();
    }

    return {
      start, stop, wake, status,
      list: () => [...watch.values()],
      isRunning: () => running,
      _add: add, _prefilter: prefilter, // test hooks
    };
  }

  root.SolSniperScanner = Object.freeze({ createScanner, LIVE_DEFAULTS });
})(typeof globalThis !== 'undefined' ? globalThis : self);
