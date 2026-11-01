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
  let currentView = 'scan';
  let scanOrigin = null; // view the user opened a token from (Live / Alerts) — "Back" returns there
  function showView(name, { fromTab = false } = {}) {
    if (name === 'scan' && currentView !== 'scan') scanOrigin = fromTab ? null : currentView;
    currentView = name;
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
    if (name === 'signals') { unseen = 0; renderCount(); }
    if (name === 'live') renderLive();
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => {
    // tapping "Скан" again while a token is open returns to the scan home screen (like iOS tab bars)
    if (b.dataset.view === 'scan' && currentView === 'scan' && current) { goHome(); return; }
    showView(b.dataset.view, { fromTab: true });
  }));
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-back]')) return;
    const origin = scanOrigin;
    goHome();
    if (origin && origin !== 'scan') showView(origin, { fromTab: true });
  });
  const backBtn = () => `<button class="back-link" data-back>‹ Назад</button>`;
  const helloHtml = $('result').innerHTML;
  let lastConnHtml = '';
  function goHome() {
    seq += 1; // drop any in-flight scan
    current = null;
    lastResult = null;
    scanOrigin = null;
    clearTimeout(refreshTimer);
    $('result').innerHTML = helloHtml;
    if (lastConnHtml) document.querySelectorAll('#result [data-conn]').forEach((b) => { b.innerHTML = lastConnHtml; });
    $('caInput').value = '';
    const u = new URL(location.href);
    u.searchParams.delete('ca');
    history.replaceState(null, '', u);
    showView('scan', { fromTab: true });
  }

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
      $('result').innerHTML = `${backBtn()}<div class="token-card"><div class="err">Не нашёл Solana-адрес. Вставь CA или ссылку на токен.</div></div>`;
      return;
    }
    const my = ++seq;
    const sameToken = current && current.address === target.address;
    current = target;
    if (!quiet || !sameToken) {
      $('result').innerHTML = `${backBtn()}<div class="token-card"><div class="loading"><span class="spinner"></span>RugCheck · DexScreener · RPC…</div></div>`;
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
      $('result').innerHTML = `${backBtn()}<div class="token-card"><div class="err">Ошибка: ${esc(e.message || e)}</div></div>`;
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
      ${backBtn()}
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
          ${trackedHoldersHtml(t)}
          ${aboutHtml(t)}
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

  // "О проекте": what the coin is tied to + short description + social buttons
  function aboutHtml(t) {
    const so = t.socials || {};
    const p = t.project || S.describeSocials(so);
    const chips = [];
    if (so.twitter) chips.push(`<a href="${esc(safeUrl(so.twitter))}" target="_blank" rel="noopener">X ${p.handle ? `@${esc(p.handle)}` : p.kind === 'community' ? 'комьюнити' : ''}</a>`);
    if (so.website) chips.push(`<a href="${esc(safeUrl(so.website))}" target="_blank" rel="noopener">Сайт ${esc(p.site || '')}</a>`);
    if (so.telegram) chips.push(`<a href="${esc(safeUrl(so.telegram))}" target="_blank" rel="noopener">Telegram</a>`);
    const desc = t.description
      ? `<p class="about-desc" data-expand>${esc(t.description)}</p>`
      : '<p class="about-desc mute">Создатель не добавил описание.</p>';
    return `<div class="about${p.hasAny ? '' : ' about-none'}">
        <div class="sec-title">О проекте</div>
        <div class="about-kind">${esc(p.label)}</div>
        ${desc}
        ${chips.length ? `<div class="links">${chips.join('')}</div>` : ''}
      </div>`;
  }
  document.addEventListener('click', (e) => {
    const d = e.target.closest('[data-expand]');
    if (d) d.classList.toggle('open');
  });

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
      ? `<div class="recent-title">Недавние</div><div class="recent">${list.map((x) => `<button data-mint="${esc(x.mint)}">$${esc(x.symbol)}</button>`).join('')}</div>`
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
      toast('Нажми на поле и выбери «Вставить»');
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
    $('wsPill').hidden = state === 'none'; // no server configured → nothing to show, scanning works without it
    $('wsDot').className = `dot ${state}`;
    $('wsText').textContent = text || state;
  }

  function connectWs() {
    clearTimeout(wsTimer);
    if (ws) { ws.onclose = null; try { ws.close(); } catch (_) { /* ignore */ } ws = null; }
    const url = settings.wsEnabled ? wsUrl() : null;
    if (!url) return setWs('none', '');
    if (location.protocol === 'https:' && url.startsWith('ws:')) return setWs('error', 'нужен https сервер');
    setWs('connecting', 'Подключение…');
    let sock;
    try { sock = new WebSocket(url); } catch (e) { setWs('error', 'ошибка URL'); return; }
    ws = sock;
    sock.onopen = () => { wsDelay = 1000; setWs('connected', 'Сигналы'); };
    sock.onmessage = (ev) => onWsMessage(ev.data).catch(() => {});
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      setWs('error', 'Сервер офлайн');
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
    pushLog(entry);
  }

  function pushLog(entry) {
    log = [entry, ...log].slice(0, 100);
    LS.set('signalLog', log);
    renderLog();
    if (entry.approved) {
      if (!$('view-signals').classList.contains('active')) { unseen += 1; renderCount(); }
      toast(`$${entry.symbol} · Score ${entry.score} · MC ${S.fmtUsd(entry.marketCap)} · ${entry.channel}`);
      beep();
      if (settings.notifyEnabled) {
        notify(`$${entry.symbol} · Score ${entry.score}/100`, `MC ${S.fmtUsd(entry.marketCap)} · Vol 5m ${S.fmtUsd(entry.vol5m)} · Top 10 ${S.fmtPct(entry.top10Pct)}\n${entry.channel}`, entry.mint, `alert-${entry.mint}`);
      }
    }
  }

  // ------------------------------------------------------------ system notifications (iOS: Home Screen app, 16.4+)
  let swReg = null;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then((r) => { swReg = r; }).catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (!e.data || e.data.type !== 'open') return;
      const ca = new URL(e.data.url, location.href).searchParams.get('ca');
      if (ca) { showView('scan'); $('caInput').value = ca; scan(parseTarget(ca)); }
    });
  }
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const isStandalone = () => window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;

  function notifState() {
    if (!('Notification' in window)) return isIOS && !isStandalone() ? 'need-home' : 'unsupported';
    return Notification.permission;
  }
  function renderNotif() {
    const st = notifState();
    const text = {
      granted: 'Уведомления включены. Приходят, пока приложение открыто или недавно свёрнуто. При заблокированном телефоне — через Telegram-бота.',
      default: 'Разреши уведомления, чтобы алерты приходили баннером, как сообщения.',
      denied: 'Уведомления запрещены. Включи их: Настройки iPhone → Уведомления → SolSniper.',
      'need-home': 'На iPhone уведомления работают только в приложении с экрана «Домой»: Поделиться → На экран «Домой», затем открой его оттуда.',
      unsupported: 'Этот браузер не поддерживает уведомления. Используй Safari и экран «Домой».',
    }[st];
    $('notifStatus').textContent = text;
    $('notifBtn').hidden = st !== 'default';
  }
  $('notifBtn').addEventListener('click', async () => {
    try { await Notification.requestPermission(); } catch (_) { /* old API */ }
    renderNotif();
    if (notifState() === 'granted') notify('Уведомления включены', 'Сюда будут приходить алерты SolSniper.', null, 'welcome');
  });

  async function notify(title, body, mint, tag) {
    if (notifState() !== 'granted') return;
    const url = mint ? `./?ca=${mint}` : './';
    try {
      const reg = swReg || (navigator.serviceWorker && await navigator.serviceWorker.ready);
      if (reg && reg.showNotification) await reg.showNotification(title, { body, icon: 'icons/icon192.png', badge: 'icons/icon192.png', tag, data: { url } });
      else new Notification(title, { body, tag });
    } catch (_) { /* ignore */ }
  }

  // ------------------------------------------------------------ live scanner (every new launch)
  let liveFilter = 'safe';
  let liveRenderPending = false;
  let wakeLock = null;
  const SRC_LABEL = { pump: 'Live · pump.fun', migration: 'Live · миграция', profile: 'Live · DexScreener' };
  const SRC_SHORT = { pump: 'pump', migration: 'migr', profile: 'dex' };
  const STATUS_LABEL = { new: 'новый', watch: 'следим', candidate: 'кандидат', checking: 'проверка…', alerted: 'алерт', rejected: 'отсеян' };

  const scanner = globalThis.SolSniperScanner.createScanner({
    analyzer,
    getSettings: () => settings,
    fetchImpl: transport,
    onEvent: (type, data) => {
      if (type === 'trade') { onTrade(data); return; }
      if (type === 'alert') {
        const t = data.result.token;
        const now = Date.now();
        pushLog({
          id: `${t.mint}:${now}`, ts: now, mint: t.mint, symbol: t.symbol, score: data.result.evaluation.score, badge: data.result.badge.level,
          approved: true, reasons: [], marketCap: t.marketCap, vol5m: t.vol5m, top10Pct: t.top10Pct,
          channel: SRC_LABEL[data.item.source] || 'Live', links: t.links,
        });
      }
      scheduleLiveRender();
    },
  });

  function scheduleLiveRender() {
    if (liveRenderPending) return;
    liveRenderPending = true;
    setTimeout(() => { liveRenderPending = false; renderLive(); }, 700);
  }
  const ago = (ts) => {
    const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    return sec < 60 ? `${sec} с` : `${Math.round(sec / 60)} мин`;
  };

  function renderLive() {
    const st = scanner.status();
    if ((settings.wallets || []).length) renderWallets();
    $('stSeen').textContent = st.seen;
    $('stWatch').textContent = st.watching;
    $('stCand').textContent = st.candidates;
    $('stAlerts').textContent = st.alerts;
    const stateTxt = {
      connecting: 'Подключаюсь к потоку…', live: 'В эфире · ловлю новые запуски', reconnecting: 'Переподключение…',
      error: 'Поток недоступен, повторяю…', unsupported: 'Браузер не поддерживает WebSocket',
    }[st.stream] || 'Выключен';
    $('liveState').textContent = st.running ? stateTxt : 'Выключен';
    $('liveState').classList.toggle('on', st.running && st.stream === 'live');
    if (!$('view-live').classList.contains('active')) return;

    let items = scanner.list();
    // "safe": only tokens that passed the whole filter (Score ≥ min, Freeze OFF, Top 10, Vol 5m, no DANGER)
    if (liveFilter === 'safe') items = items.filter((t) => t.status === 'alerted');
    else if (liveFilter === 'checked') items = items.filter((t) => t.score != null || t.status === 'checking' || t.status === 'candidate');
    items.sort(liveFilter === 'all'
      ? (a, b) => b.firstSeen - a.firstSeen
      : (a, b) => (b.status === 'alerted') - (a.status === 'alerted') || (b.score ?? -1) - (a.score ?? -1) || ((b.metrics && b.metrics.vol5m) || 0) - ((a.metrics && a.metrics.vol5m) || 0));
    items = items.slice(0, 60);
    if (!items.length) {
      const msg = !st.running ? 'Включи Live-сканер переключателем выше.'
        : liveFilter === 'safe' ? `Пока ни один токен не прошёл фильтр: Score ≥ ${settings.minScore}, Freeze OFF, Top 10 ≤ ${settings.maxTop10Pct}%, Vol 5m ≥ ${S.fmtUsd(settings.minVol5mUsd)}. Проходит меньшинство — это нормально. Отсеянные с причинами — во вкладке «Проверенные».`
          : liveFilter === 'checked' ? 'Ещё ни один токен не набрал объём для полной проверки. Подожди пару минут.'
            : 'Собираю данные… Первые цифры появятся примерно через минуту.';
      $('liveList').innerHTML = `<div class="empty">${msg}</div>`;
      return;
    }
    $('liveList').innerHTML = items.map((t) => {
      const m = t.metrics || {};
      const score = (t.status === 'alerted' || t.status === 'rejected') && t.score != null ? `${t.score} · ` : '';
      return `
      <button class="live-row ${esc(t.status)}" data-mint="${esc(t.mint)}">
        <div class="lr-main"><b>${esc(t.symbol ? `$${t.symbol}` : S.shortAddr(t.mint))}</b><span class="tag">${esc(SRC_SHORT[t.source] || t.source)}</span><span class="meta">${ago(t.firstSeen)}</span></div>
        <div class="lr-nums"><span>MC ${esc(S.fmtUsd(m.mc))}</span><span>Vol 5m ${esc(S.fmtUsd(m.vol5m))}</span></div>
        <div class="lr-st"><span class="st-chip ${esc(t.status)}">${score}${esc(STATUS_LABEL[t.status] || t.status)}</span>${t.status === 'rejected' && t.reasons[0] ? `<span class="meta lr-why">${esc(t.reasons[0])}</span>` : ''}</div>
      </button>`;
    }).join('');
  }

  $('liveList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mint]');
    if (!b) return;
    $('caInput').value = b.dataset.mint;
    showView('scan');
    scan({ address: b.dataset.mint, kind: 'mint' });
  });
  $('liveFilter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]');
    if (!b) return;
    liveFilter = b.dataset.f;
    document.querySelectorAll('#liveFilter button').forEach((x) => x.classList.toggle('active', x === b));
    renderLive();
  });

  // Screen Wake Lock keeps iOS from sleeping (and freezing the stream) while Live runs, e.g. on a charger.
  async function setKeepAwake(on) {
    try {
      if (on && 'wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!on && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (_) { /* not supported / denied */ }
  }
  function applyLive() {
    if (settings.liveEnabled) scanner.start(); else scanner.stop();
    setKeepAwake(settings.liveEnabled && settings.keepAwake);
    $('liveToggle').checked = !!settings.liveEnabled;
    renderLive();
  }
  $('liveToggle').addEventListener('change', () => {
    settings.liveEnabled = $('liveToggle').checked;
    saveSettings();
    applyLive();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !settings.liveEnabled) return;
    scanner.wake();
    setKeepAwake(settings.keepAwake);
  });
  setInterval(() => { if (scanner.isRunning()) renderLive(); }, 5000);

  // ------------------------------------------------------------ Live: launches / wallets switch
  $('liveMode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    document.querySelectorAll('#liveMode button').forEach((x) => x.classList.toggle('active', x === b));
    $('liveLaunches').hidden = b.dataset.m !== 'launches';
    $('liveWallets').hidden = b.dataset.m !== 'wallets';
    if (b.dataset.m === 'wallets') renderTrades();
  });

  // ------------------------------------------------------------ tracked wallets (KOL / traders)
  let trades = LS.get('walletTrades', []);
  const tokenInfo = new Map();   // mint -> { symbol, mc }
  const pendingInfo = new Set();
  const clusterAlerted = new Set(LS.get('clusterAlerted', []));
  const CLUSTER_WINDOW_MS = 30 * 60_000;
  const walletName = (addr) => {
    const w = (settings.wallets || []).find((x) => x.address === addr);
    return (w && w.label) || S.shortAddr(addr);
  };

  function renderWallets() {
    const list = settings.wallets || [];
    $('walletChips').innerHTML = list.map((w) => `<span class="w-chip"><b>${esc(w.label || S.shortAddr(w.address))}</b><span class="mono">${esc(S.shortAddr(w.address))}</span><button data-wdel="${esc(w.address)}" aria-label="Удалить">×</button></span>`).join('');
    const st = scanner.status();
    $('walletState').textContent = !list.length ? 'Добавь кошельки KOL или трейдеров'
      : st.stream === 'live' ? `Слежу за ${list.length} · в эфире` : `Слежу за ${list.length} · подключение…`;
  }
  $('wAdd').addEventListener('click', () => {
    const addr = $('wAddr').value.trim();
    if (!S.isBase58Address(addr)) { toast('Это не адрес Solana-кошелька'); return; }
    const list = (settings.wallets || []).filter((w) => w.address !== addr);
    list.push({ address: addr, label: $('wLabel').value.trim().slice(0, 24) });
    if (list.length > 50) { toast('Максимум 50 кошельков'); return; }
    settings.wallets = list;
    saveSettings();
    $('wAddr').value = '';
    $('wLabel').value = '';
    scanner.setWallets(settings.wallets);
    renderWallets();
  });
  $('walletChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-wdel]');
    if (!b) return;
    settings.wallets = (settings.wallets || []).filter((w) => w.address !== b.dataset.wdel);
    saveSettings();
    scanner.setWallets(settings.wallets);
    renderWallets();
  });

  function buyersOf(mint) {
    const since = Date.now() - CLUSTER_WINDOW_MS;
    return [...new Set(trades.filter((t) => t.mint === mint && t.side === 'buy' && t.ts >= since).map((t) => t.wallet))];
  }

  function onTrade(tr) {
    trades = [tr, ...trades].slice(0, 150);
    LS.set('walletTrades', trades);
    if (!tokenInfo.has(tr.mint)) pendingInfo.add(tr.mint);
    const sym = tokenInfo.get(tr.mint) && tokenInfo.get(tr.mint).symbol;
    const name = walletName(tr.wallet);
    const what = sym ? `$${sym}` : S.shortAddr(tr.mint);
    if (settings.walletNotify && tr.side === 'buy') {
      notify(`${name} купил ${what}`, `${tr.sol != null ? `${tr.sol.toFixed(2)} SOL` : ''}${tr.mcSol ? ` · MC ${Math.round(tr.mcSol)} SOL` : ''}`, tr.mint, `buy-${tr.wallet}-${tr.mint}`);
    }
    const buyers = buyersOf(tr.mint);
    if (tr.side === 'buy' && buyers.length >= 2 && !clusterAlerted.has(tr.mint)) {
      clusterAlerted.add(tr.mint);
      LS.set('clusterAlerted', [...clusterAlerted].slice(-200));
      const names = buyers.map(walletName).join(', ');
      toast(`${buyers.length} кошелька зашли в ${what}: ${names}`);
      beep();
      if (settings.walletNotify) notify(`${buyers.length} кошелька купили ${what}`, names, tr.mint, `cluster-${tr.mint}`);
    }
    renderTrades();
  }

  // Resolve symbols / market caps for traded mints in one DexScreener batch.
  setInterval(async () => {
    if (!pendingInfo.size) return;
    const mints = [...pendingInfo].slice(0, 30);
    mints.forEach((m) => pendingInfo.delete(m));
    try {
      const res = await transport(`https://api.dexscreener.com/tokens/v1/solana/${mints.join(',')}`, { headers: { accept: 'application/json' } });
      const pairs = res.ok ? await res.json() : [];
      for (const p of Array.isArray(pairs) ? pairs : []) {
        const m = p.baseToken && p.baseToken.address;
        if (m && !tokenInfo.has(m)) tokenInfo.set(m, { symbol: p.baseToken.symbol, mc: S.num(p.marketCap || p.fdv) });
      }
      renderTrades();
    } catch (_) { mints.forEach((m) => pendingInfo.add(m)); }
  }, 4000);

  function renderTrades() {
    renderWallets();
    if ($('liveWallets').hidden || !$('view-live').classList.contains('active')) return;
    if (!trades.length) {
      $('tradeList').innerHTML = `<div class="empty">${(settings.wallets || []).length ? 'Ждём сделок… Они появятся здесь сразу, как кошелёк купит или продаст.' : 'Добавь хотя бы один кошелёк выше.'}</div>`;
      return;
    }
    $('tradeList').innerHTML = trades.slice(0, 80).map((tr) => {
      const info = tokenInfo.get(tr.mint) || {};
      if (!tokenInfo.has(tr.mint)) pendingInfo.add(tr.mint);
      const n = tr.side === 'buy' ? buyersOf(tr.mint).length : 0;
      return `
      <button class="live-row trade ${tr.side}" data-mint="${esc(tr.mint)}">
        <div class="lr-main"><b>${esc(info.symbol ? `$${info.symbol}` : S.shortAddr(tr.mint))}</b><span class="st-chip ${tr.side === 'buy' ? 'alerted' : ''}">${tr.side === 'buy' ? 'покупка' : 'продажа'}</span>${n >= 2 ? `<span class="st-chip candidate">${n} кошелька</span>` : ''}<span class="meta">${ago(tr.ts)}</span></div>
        <div class="lr-nums"><span>${esc(walletName(tr.wallet))}</span><span>${tr.sol != null ? `${esc(tr.sol.toFixed(2))} SOL` : ''}</span><span>MC ${esc(info.mc != null ? S.fmtUsd(info.mc) : tr.mcSol ? `${Math.round(tr.mcSol)} SOL` : 'n/a')}</span></div>
      </button>`;
    }).join('');
  }
  $('tradeList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mint]');
    if (!b) return;
    $('caInput').value = b.dataset.mint;
    showView('scan');
    scan({ address: b.dataset.mint, kind: 'mint' });
  });

  function trackedHoldersHtml(t) {
    const owners = new Set(t.holderOwners || []);
    const hits = (settings.wallets || []).filter((w) => owners.has(w.address));
    const buyers = buyersOf(t.mint).filter((a) => !hits.some((h) => h.address === a));
    if (!hits.length && !buyers.length) return '';
    const parts = [];
    if (hits.length) parts.push(`держат: ${hits.map((w) => esc(w.label || S.shortAddr(w.address))).join(', ')}`);
    if (buyers.length) parts.push(`покупали за 30 мин: ${buyers.map((a) => esc(walletName(a))).join(', ')}`);
    return `<div class="filter-note filter-ok">Твои кошельки · ${parts.join(' · ')}</div>`;
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
    if (!audioCtx || settings.soundEnabled === false) return;
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
        if (k === 'heliusApiKey' || k === 'rpcUrl') checkConnections();
        if (k === 'keepAwake') setKeepAwake(settings.liveEnabled && settings.keepAwake);
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

  // ------------------------------------------------------------ connection check
  const PROBE_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC: always indexed everywhere

  async function probeJson(url, init = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await transport(url, { ...init, signal: ctrl.signal, headers: { accept: 'application/json', ...(init.headers || {}) } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('нет ответа (4 с)');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  function explain(name, msg) {
    if (/HTTP 401|HTTP 403/.test(msg) && name.includes('Helius')) return 'ключ не принят — скопируй заново';
    if (/HTTP 429/.test(msg)) return 'лимит запросов — подожди минуту';
    if (/Failed to fetch|Load failed|NetworkError|CORS/i.test(msg)) return 'заблокировано браузером (Brave Shields?)';
    return msg;
  }

  async function checkConnections() {
    const helius = !!settings.heliusApiKey && !settings.rpcUrl;
    const checks = [
      ['DexScreener', 'цены, объём, ликвидность', () => probeJson(`https://api.dexscreener.com/latest/dex/tokens/${PROBE_MINT}`)],
      ['RugCheck', 'риски, LP, dev', () => probeJson(`https://api.rugcheck.xyz/v1/tokens/${PROBE_MINT}/report/summary`)],
      [helius ? 'Helius RPC' : settings.rpcUrl ? 'Custom RPC' : 'Public RPC', 'Mint, Freeze, Top 10', async () => {
        const j = await probeJson(analyzer.rpcEndpoint(), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }),
        });
        if (j.error) throw new Error(j.error.message || 'RPC error');
      }],
    ];
    const boxes = document.querySelectorAll('[data-conn]');
    const row = (cls, ic, name, sub, st) => `<div class="conn-row ${cls}"><span class="ic">${ic}</span><div><b>${esc(name)}</b><div class="meta">${esc(sub)}</div></div><span class="st">${esc(st)}</span></div>`;
    boxes.forEach((b) => { b.innerHTML = checks.map(([n, sub]) => row('wait', '…', n, sub, 'проверка')).join(''); });
    const results = await Promise.all(checks.map(async ([name, sub, fn]) => {
      const t0 = performance.now();
      try { await fn(); return { name, sub, ok: true, st: `${Math.round(performance.now() - t0)} мс` }; } catch (e) { return { name, sub, ok: false, st: explain(name, String(e.message || e)) }; }
    }));
    let html = results.map((r) => row(r.ok ? 'ok' : 'fail', r.ok ? '✓' : '✕', r.name, r.sub, r.st)).join('');
    if (!helius && !settings.rpcUrl) {
      html += '<div class="conn-tip">Нужен ключ Helius: без него Mint, Freeze и Top 10 не проверяются. Скопируй ключ на dashboard.helius.dev (API Keys → Copy) и нажми кнопку ниже.</div>'
        + '<button class="btn primary sm key-paste" data-pastekey>Вставить ключ Helius из буфера</button>';
    }
    else if (results.every((r) => r.ok)) html += '<div class="conn-tip">Всё подключено. Можно сканировать.</div>';
    lastConnHtml = html;
    boxes.forEach((b) => { b.innerHTML = html; });
  }
  document.addEventListener('click', (e) => { if (e.target.closest('[data-conncheck]')) checkConnections(); });
  document.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-pastekey]')) return;
    let text = '';
    try { text = (await navigator.clipboard.readText()).trim(); } catch (_) { /* clipboard denied */ }
    if (!text) {
      showView('settings');
      const f = document.querySelector('[data-k="heliusApiKey"]');
      f.focus();
      toast('Нажми на поле «Helius API key» и выбери «Вставить»');
      return;
    }
    settings.heliusApiKey = text;
    saveSettings();
    analyzer.clearCache();
    fillSettingsForm();
    toast('Ключ сохранён, проверяю…');
    checkConnections();
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
  else checkConnections();
  applyLive();
  scanner.setWallets(settings.wallets || []);
  renderWallets();
  renderNotif();
})();
