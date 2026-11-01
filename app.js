/* SolSniper web app (iPhone / any browser): manual scanner + live signal feed from server.py. */
(function () {
  'use strict';
  const S = globalThis.SolSniper;
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : '#');

  const APP_DEFAULTS = { serverUrl: '', serverToken: '', wsEnabled: true };
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(`solsniper.${k}`); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(`solsniper.${k}`, JSON.stringify(v)); } catch (_) { /* private mode */ } },
  };

  // If the app is served by server.py itself (/app/), default the server URL to this origin.
  const servedByRelay = /\/app\/?$/.test(location.pathname) || location.pathname.endsWith('/app/index.html');
  let settings = { ...S.DEFAULT_SETTINGS, ...APP_DEFAULTS, ...(servedByRelay ? { serverUrl: location.origin } : {}), ...LS.get('settings', {}) };
  const saveSettings = () => LS.set('settings', settings);

  // ------------------------------------------------------------ transport: direct, falling back to server.py /proxy on CORS errors
  const proxiedHosts = new Set(LS.get('proxiedHosts', []));
  const serverBase = () => (settings.serverUrl || '').trim().replace(/\/+$/, '');

  async function viaProxy(url, init) {
    const base = serverBase();
    if (!base) throw new Error('CORS blocked — укажите URL сервера в настройках');
    const headers = { ...(init.headers || {}) };
    if (settings.serverToken) headers['x-relay-token'] = settings.serverToken;
    return fetch(`${base}/proxy?url=${encodeURIComponent(url)}`, { ...init, headers });
  }

  async function transport(url, init) {
    const host = new URL(url).hostname;
    if (proxiedHosts.has(host) && serverBase()) return viaProxy(url, init);
    try {
      return await fetch(url, init);
    } catch (e) {
      if (e.name === 'AbortError' || !serverBase()) throw e;
      proxiedHosts.add(host); // TypeError = network/CORS → remember and use the relay
      LS.set('proxiedHosts', [...proxiedHosts]);
      return viaProxy(url, init);
    }
  }

  const analyzer = globalThis.SolSniperAnalyzer.createAnalyzer({ getSettings: () => settings, fetchImpl: transport });

  // ------------------------------------------------------------ navigation
  function showView(name) {
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
    if (name === 'signals') { unseen = 0; renderCount(); }
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

  // ------------------------------------------------------------ input parsing
  /** Accepts a bare CA or any DEX / pump.fun / Photon / GMGN / BullX link. */
  function parseTarget(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    let kind = 'unknown';
    try {
      const u = new URL(raw);
      const h = u.hostname.replace(/^www\./, '');
      if (h === 'dexscreener.com' || h === 'photon-sol.tinyastro.io' || h === 'axiom.trade') kind = 'pair';
      else if (h.endsWith('pump.fun') || h === 'gmgn.ai' || h.endsWith('solscan.io') || h.endsWith('rugcheck.xyz') || h.endsWith('birdeye.so')) kind = 'mint';
      const q = u.searchParams.get('address') || u.searchParams.get('ca') || u.searchParams.get('mint');
      if (q && S.isBase58Address(q)) return { address: q, kind: 'unknown' };
      const addr = S.extractAddresses(u.pathname.replace(/_/g, ' '), 5).pop();
      return addr ? { address: addr, kind } : null;
    } catch (_) { /* not a URL */ }
    const addr = S.extractAddresses(raw, 1)[0];
    return addr ? { address: addr, kind: 'unknown' } : null;
  }

  // ------------------------------------------------------------ scan
  let current = null;   // { address, kind }
  let lastResult = null;
  let seq = 0;
  let refreshTimer = null;

  async function scan(target, { force = true, quiet = false } = {}) {
    if (!target) {
      $('result').innerHTML = '<div class="token-card"><div class="err">Не нашёл Solana-адрес. Вставьте CA или ссылку на токен.</div></div>';
      return;
    }
    const my = ++seq;
    const sameToken = current && current.address === target.address;
    current = target;
    if (!quiet || !sameToken) {
      $('result').innerHTML = `<div class="token-card"><div class="loading"><span class="spinner"></span>RugCheck · DexScreener · RPC…</div></div>`;
      lastResult = null;
    }
    try {
      const r = await analyzer.analyzeToken(target.address, target.kind, force);
      if (my !== seq) return;
      lastResult = r;
      renderResult();
      pushRecent(r.token);
      const u = new URL(location.href);
      u.searchParams.set('ca', r.token.mint);
      history.replaceState(null, '', u);
    } catch (e) {
      if (my !== seq) return;
      $('result').innerHTML = `<div class="token-card"><div class="err">Ошибка: ${esc(e.message || e)}</div></div>`;
    }
    scheduleRefresh();
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (!settings.autoCheck || !current) return;
    refreshTimer = setTimeout(() => {
      if (document.visibilityState === 'visible' && $('view-scan').classList.contains('active')) scan(current, { force: true, quiet: true });
      else scheduleRefresh();
    }, 15_000);
  }

  const kv = (label, value) => `<div class="kv"><span class="k">${esc(label)}</span><span class="v">${value}</span></div>`;
  const onOff = (v) => (v == null ? '<span class="chip chip-mute">n/a</span>' : `<span class="chip ${v ? 'chip-bad' : 'chip-good'}">${v ? 'ON' : 'OFF'}</span>`);
  const level = (v, warnAt, badAt) => {
    if (S.num(v) === null) return '<span class="mute">n/a</span>';
    return `<span class="${v >= badAt ? 'bad' : v >= warnAt ? 'warn' : 'good'}">${esc(S.fmtPct(v))}</span>`;
  };

  function renderResult() {
    if (!lastResult) return;
    const { token: t, evaluation: ev, badge, filter } = lastResult;
    const lp = t.isBondingCurve
      ? '<span class="chip chip-good">CURVE</span>'
      : (S.num(t.lpBurnedPct) === null ? '<span class="mute">n/a</span>'
        : `<span class="${t.lpBurnedPct >= 99 ? 'good' : t.lpBurnedPct >= 50 ? 'warn' : 'bad'}">${t.lpBurnedPct.toFixed(0)}%</span>`);
    const scoreCls = ev.score >= settings.minScore ? 'good' : ev.score >= 40 ? 'warn' : 'bad';
    const dot = (ok, name, key) => `<span class="src ${ok ? 'ok' : 'fail'}" title="${esc(ok ? name : (t.errors[key] || 'no data'))}">${esc(name)}</span>`;
    const errorsList = Object.entries(t.errors).map(([k, v]) => `${k}: ${v}`).join(' · ');

    $('result').innerHTML = `
      <div class="token-card">
        <div class="token-head">
          ${t.imageUrl ? `<img src="${esc(safeUrl(t.imageUrl))}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
          <div class="names">
            <div><span class="sym">$${esc(t.symbol)}</span> <button class="addr" id="copyCa">${esc(S.shortAddr(t.mint))} ⧉</button></div>
            <div class="nm">${esc(t.name)}${t.dexId ? ` · ${esc(t.dexId)}` : ''}</div>
          </div>
          <span class="score ${scoreCls}">${ev.score}</span>
        </div>
        <div class="body">
          <div class="badge-row">
            <span class="badge badge-${badge.level.toLowerCase()}">${badge.level}</span>
            <span class="verdict ${ev.passed ? 'good' : 'bad'}">${ev.passed ? 'PASS' : 'HIGH RUG RISK'}</span>
          </div>
          <div class="grid">
            <div class="card"><div class="sec-title">Rug</div>${kv('Mint', onOff(t.mintAuthority))}${kv('Freeze', onOff(t.freezeAuthority))}${kv('LP burn', lp)}</div>
            <div class="card"><div class="sec-title">Holders</div>${kv('Top 10', level(t.top10Pct, 15, 30))}${kv('Dev', level(t.devPct, 5, 10))}${kv('Всего', esc(t.totalHolders ?? 'n/a'))}</div>
            <div class="card"><div class="sec-title">Market</div>${kv('MC', esc(S.fmtUsd(t.marketCap)))}${kv('Vol 5m', esc(S.fmtUsd(t.vol5m)))}${kv('Liq', esc(S.fmtUsd(t.liquidityUsd)))}</div>
          </div>
          <div class="score-box">
            <div class="bar"><div class="bar-fill ${scoreCls}" style="width:${ev.score}%"></div></div>
            <ul class="breakdown">${ev.breakdown.map((b) => `<li class="${b.ok ? 'good' : 'mute'}"><span>${b.ok ? '✓' : '✗'} ${esc(b.label)}</span><span>${esc(b.detail)} · +${b.points}</span></li>`).join('')}</ul>
          </div>
          ${filter.approved ? '<div class="filter-note filter-ok">✓ Проходит фильтр сигналов</div>' : `<div class="filter-note">✗ ${esc(filter.reasons.join(' · '))}</div>`}
          ${badge.reasons.length ? `<details class="risks"><summary>${badge.reasons.length} флаг(ов) риска</summary><ul>${badge.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}
        </div>
        <div class="calc">
          <div class="sec-title">Risk Calc</div>
          <div class="calc-in">
            <label class="field"><span>Депозит</span><input id="cDep" type="number" inputmode="decimal" value="${esc(settings.depositAmount)}"></label>
            <label class="field field-sm"><span>Валюта</span><select id="cCur"><option ${settings.depositCurrency === 'USD' ? 'selected' : ''}>USD</option><option ${settings.depositCurrency === 'SOL' ? 'selected' : ''}>SOL</option></select></label>
            <label class="field field-sm"><span>Риск %</span><input id="cRisk" type="number" inputmode="decimal" value="${esc(settings.riskPct)}"></label>
          </div>
          <div class="calc-out" id="calcOut"></div>
        </div>
        <div class="ftr">
          <div class="links">
            <a href="${safeUrl(t.links.photon)}" target="_blank" rel="noopener">Photon</a>
            <a href="${safeUrl(t.links.dexscreener)}" target="_blank" rel="noopener">DEX</a>
            <a href="${safeUrl(t.links.rugcheck)}" target="_blank" rel="noopener">RugCheck</a>
            ${t.socials.twitter ? `<a href="${safeUrl(t.socials.twitter)}" target="_blank" rel="noopener">𝕏</a>` : ''}
          </div>
          <div class="srcs">${dot(t.sources.dexscreener, 'DexScreener', 'dexscreener')}${dot(t.sources.rugcheck, 'RugCheck', 'rugcheck')}${dot(t.sources.rpc, 'RPC', 'rpc')}
            <span class="mute">${esc(new Date(t.fetchedAt).toLocaleTimeString())}</span></div>
          ${errorsList ? `<div class="hint">${esc(errorsList)}</div>` : ''}
        </div>
      </div>`;

    $('copyCa').addEventListener('click', (e) => {
      navigator.clipboard.writeText(t.mint).then(() => { e.target.textContent = 'скопирован'; }).catch(() => {});
    });
    for (const [id, k] of [['cDep', 'depositAmount'], ['cCur', 'depositCurrency'], ['cRisk', 'riskPct']]) {
      $(id).addEventListener('input', (e) => {
        settings[k] = k === 'depositCurrency' ? e.target.value : parseFloat(e.target.value);
        saveSettings();
        fillSettingsForm();
        renderCalc();
      });
    }
    renderCalc();
  }

  function renderCalc() {
    const out = $('calcOut');
    if (!out || !lastResult) return;
    const t = lastResult.token;
    const c = S.calcPosition({
      deposit: settings.depositAmount, currency: settings.depositCurrency, riskPct: settings.riskPct,
      solUsd: t.solUsd, priceUsd: t.priceUsd, marketCap: t.marketCap, tpMultiple: settings.tpMultiple, tpSellPct: settings.tpSellPct,
    });
    out.innerHTML = !c ? '<div class="mute">Введите депозит и риск %</div>' : `
      ${kv('Позиция', `<b>${esc(S.fmtUsd(c.positionUsd))}</b> <span class="mute">${esc(S.fmtSol(c.positionSol))}</span>`)}
      ${kv(`TP ${c.tpSellPct}% @ ${c.tpMultiple}x`, `<b class="good">${esc(S.fmtPrice(c.tpPriceUsd))}</b>`)}
      ${kv('TP Market Cap', esc(S.fmtUsd(c.tpMarketCap)))}
      ${kv('Вывод на TP', `${esc(S.fmtUsd(c.sellValueUsd))}`)}`;
  }

  // recent scans
  function pushRecent(t) {
    const list = LS.get('recent', []).filter((x) => x.mint !== t.mint);
    list.unshift({ mint: t.mint, symbol: t.symbol });
    LS.set('recent', list.slice(0, 10));
    renderRecent();
  }
  function renderRecent() {
    const list = LS.get('recent', []);
    $('recent').innerHTML = list.length
      ? `<div class="sec-title">Недавние</div><div class="recent">${list.map((x) => `<button data-mint="${esc(x.mint)}">$${esc(x.symbol)}</button>`).join('')}</div>`
      : '';
  }
  $('recent').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mint]');
    if (b) { $('caInput').value = b.dataset.mint; scan({ address: b.dataset.mint, kind: 'mint' }); }
  });

  $('checkBtn').addEventListener('click', () => { $('caInput').blur(); scan(parseTarget($('caInput').value)); });
  $('caInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { $('caInput').blur(); scan(parseTarget($('caInput').value)); } });
  $('pasteBtn').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText(); // iOS shows a "Paste" confirmation bubble
      $('caInput').value = text.trim();
      scan(parseTarget(text));
    } catch (_) {
      $('caInput').focus();
      toast('Нажмите на поле и выберите «Вставить»');
    }
  });

  // ------------------------------------------------------------ signals over WebSocket
  let ws = null;
  let wsTimer = null;
  let wsDelay = 1000;
  let unseen = 0;
  let log = LS.get('signalLog', []);
  const seen = new Map();

  function wsUrl() {
    const base = serverBase();
    if (!base) return null;
    const u = new URL(base);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/';
    if (settings.serverToken) u.searchParams.set('token', settings.serverToken);
    return u.toString();
  }

  function setWs(state, text) {
    $('wsDot').className = `dot ${state}`;
    $('wsText').textContent = text || state;
  }

  function connectWs() {
    clearTimeout(wsTimer);
    if (ws) { ws.onclose = null; try { ws.close(); } catch (_) { /* ignore */ } ws = null; }
    const url = settings.wsEnabled ? wsUrl() : null;
    if (!url) return setWs('', settings.wsEnabled ? 'нет сервера' : 'выкл');
    if (location.protocol === 'https:' && url.startsWith('ws:')) return setWs('error', 'нужен https сервер');
    setWs('connecting', '…');
    let sock;
    try { sock = new WebSocket(url); } catch (e) { setWs('error', 'ошибка URL'); return; }
    ws = sock;
    sock.onopen = () => { wsDelay = 1000; setWs('connected', 'online'); };
    sock.onmessage = (ev) => onWsMessage(ev.data).catch(() => {});
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      setWs('error', 'offline');
      if (document.visibilityState === 'visible') {
        wsTimer = setTimeout(connectWs, wsDelay);
        wsDelay = Math.min(wsDelay * 2, 30_000);
      }
    };
  }
  setInterval(() => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping', ts: Date.now() })); }, 20_000);

  // iOS freezes background tabs: reconnect as soon as the app comes back to the foreground.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!ws || ws.readyState > 1) { wsDelay = 1000; connectWs(); }
    if (current && settings.autoCheck) scheduleRefresh();
  });
  $('wsPill').addEventListener('click', () => { wsDelay = 1000; connectWs(); });

  async function onWsMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!msg || msg.type !== 'signal') return;
    const addrs = (Array.isArray(msg.mints) ? msg.mints : msg.mint ? [msg.mint] : S.extractAddresses(msg.text || '', 3))
      .filter(S.isBase58Address).slice(0, 3);
    for (const a of addrs) {
      if (seen.has(a) && Date.now() - seen.get(a) < 10 * 60_000) continue;
      seen.set(a, Date.now());
      await processSignal(a, msg);
    }
  }

  async function processSignal(address, msg) {
    let entry;
    const now = Date.now();
    try {
      const r = await analyzer.analyzeToken(address, 'unknown', true);
      const t = r.token;
      entry = {
        id: `${t.mint}:${now}`, ts: now, mint: t.mint, symbol: t.symbol, score: r.evaluation.score, badge: r.badge.level,
        approved: r.filter.approved, reasons: r.filter.reasons, marketCap: t.marketCap, vol5m: t.vol5m, top10Pct: t.top10Pct,
        channel: String(msg.channel || 'signal').slice(0, 80), links: t.links,
      };
    } catch (e) {
      entry = {
        id: `${address}:${now}`, ts: now, mint: address, symbol: '???', score: 0, badge: 'DANGER', approved: false,
        reasons: [`Ошибка анализа: ${e.message || e}`], channel: String(msg.channel || 'signal').slice(0, 80), links: S.links(address, null),
      };
    }
    log = [entry, ...log].slice(0, 100);
    LS.set('signalLog', log);
    renderLog();
    if (entry.approved) {
      if (!$('view-signals').classList.contains('active')) { unseen += 1; renderCount(); }
      toast(`SIGNAL  $${entry.symbol} · score ${entry.score} · MC ${S.fmtUsd(entry.marketCap)}`);
      beep();
    }
  }

  function renderCount() {
    $('sigCount').hidden = unseen === 0;
    $('sigCount').textContent = unseen;
  }

  function renderLog() {
    const showRej = $('showRejected').checked;
    const items = log.filter((e) => showRej || e.approved);
    if (!items.length) {
      $('log').innerHTML = `<div class="empty">${serverBase() ? 'Пока нет одобренных сигналов.' : 'Укажите URL сервера в Настройках, чтобы получать сигналы из Telegram.'}<br>Сигналы приходят, только пока приложение открыто.</div>`;
      return;
    }
    $('log').innerHTML = items.map((e) => `
      <div class="sig ${e.approved ? '' : 'rej'}">
        <div class="sig-top">
          <b>$${esc(e.symbol)}</b><span class="badge badge-${esc(String(e.badge).toLowerCase())}">${esc(e.badge)}</span>
          <b class="${e.approved ? 'good' : 'bad'}">${esc(e.score)}</b><span class="grow"></span>
          <span class="meta">${esc(new Date(e.ts).toLocaleTimeString())}</span>
        </div>
        <div class="meta">MC ${esc(S.fmtUsd(e.marketCap))} · Vol5m ${esc(S.fmtUsd(e.vol5m))} · Top10 ${esc(S.fmtPct(e.top10Pct))} · ${esc(e.channel)}</div>
        ${e.approved ? '' : `<div class="meta bad">${esc((e.reasons || []).join(' · '))}</div>`}
        <div class="links">
          <a href="${safeUrl(e.links && e.links.photon)}" target="_blank" rel="noopener">Open in Photon</a>
          <a href="${safeUrl(e.links && e.links.dexscreener)}" target="_blank" rel="noopener">Open in DEXScreener</a>
          <a href="#" data-scan="${esc(e.mint)}">Скан</a>
        </div>
      </div>`).join('');
  }
  $('log').addEventListener('click', (e) => {
    const a = e.target.closest('[data-scan]');
    if (!a) return;
    e.preventDefault();
    $('caInput').value = a.dataset.scan;
    showView('scan');
    scan({ address: a.dataset.scan, kind: 'mint' });
  });
  $('showRejected').addEventListener('change', renderLog);
  $('clearLog').addEventListener('click', () => { log = []; LS.set('signalLog', log); renderLog(); });

  // ------------------------------------------------------------ toast + sound
  let toastTimer = null;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
  }
  let audioCtx = null;
  // iOS only allows audio after a user gesture: unlock on first tap.
  document.addEventListener('touchend', () => {
    if (audioCtx) return;
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch (_) { /* no audio */ }
  }, { once: true, passive: true });
  function beep() {
    if (!audioCtx) return;
    try {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.15, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.25);
      o.connect(g).connect(audioCtx.destination);
      o.start();
      o.stop(audioCtx.currentTime + 0.25);
    } catch (_) { /* ignore */ }
  }

  // ------------------------------------------------------------ settings form
  const fields = document.querySelectorAll('#view-settings [data-k]');
  function fillSettingsForm() {
    fields.forEach((el) => {
      const v = settings[el.dataset.k];
      if (el.type === 'checkbox') el.checked = !!v;
      else if (document.activeElement !== el) el.value = v ?? '';
    });
    $('settingsInfo').textContent = `RPC: ${analyzer.rpcEndpoint().replace(/api-key=[^&]+/, 'api-key=***').replace(/^https:\/\//, '')}`
      + (proxiedHosts.size ? ` · через сервер: ${[...proxiedHosts].join(', ')}` : '');
  }
  let saveTimer = null;
  fields.forEach((el) => {
    el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
      const k = el.dataset.k;
      if (el.type === 'checkbox') settings[k] = el.checked;
      else if (el.type === 'number') { const n = parseFloat(el.value); settings[k] = Number.isFinite(n) ? n : S.DEFAULT_SETTINGS[k]; }
      else settings[k] = el.value.trim();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveSettings();
        analyzer.clearCache();
        if (['serverUrl', 'serverToken', 'wsEnabled'].includes(k)) {
          proxiedHosts.clear();
          LS.set('proxiedHosts', []);
          wsDelay = 1000;
          connectWs();
        }
        fillSettingsForm();
        if (lastResult) { lastResult = analyzer.rescore(lastResult.token); renderResult(); }
      }, 400);
    });
  });

  // ------------------------------------------------------------ clock
  const tick = () => { $('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); };
  tick();
  setInterval(tick, 1000);

  // ------------------------------------------------------------ init
  fillSettingsForm();
  renderRecent();
  renderLog();
  connectWs();
  const initial = new URLSearchParams(location.search).get('ca');
  if (initial) {
    $('caInput').value = initial;
    scan(parseTarget(initial));
  }
})();
