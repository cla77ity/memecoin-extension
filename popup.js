/* SolSniper popup: settings, manual scan, signal log. */
(function () {
  'use strict';
  const S = globalThis.SolSniper;
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : '#');
  const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: String(e.message || e) }));

  let settings = { ...S.DEFAULT_SETTINGS };
  let log = [];

  // ------------------------------------------------------------ tabs
  document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
    try { localStorage.setItem('solsniper.tab', b.dataset.tab); } catch (_) { /* ignore */ }
  }));
  try {
    const t = localStorage.getItem('solsniper.tab');
    if (t) document.querySelector(`nav button[data-tab="${t}"]`)?.click();
  } catch (_) { /* ignore */ }

  // ------------------------------------------------------------ settings form
  const fields = document.querySelectorAll('#tab-filters [data-k]');

  function fillForm() {
    fields.forEach((el) => {
      const v = settings[el.dataset.k];
      if (el.type === 'checkbox') el.checked = !!v;
      else if (document.activeElement !== el) el.value = v ?? '';
    });
  }

  let saveTimer = null;
  function readField(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'number') {
      const n = parseFloat(el.value);
      return Number.isFinite(n) ? n : S.DEFAULT_SETTINGS[el.dataset.k];
    }
    return el.value.trim();
  }
  fields.forEach((el) => {
    const evt = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(evt, () => {
      settings[el.dataset.k] = readField(el);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, el.type === 'checkbox' ? 0 : 350);
    });
  });

  async function save() {
    try {
      if (settings.wsUrl && !/^wss?:\/\//i.test(settings.wsUrl)) throw new Error('WS URL должен начинаться с ws:// или wss://');
      if (settings.rpcUrl && !/^https:\/\//i.test(settings.rpcUrl)) throw new Error('RPC URL должен быть https://');
      await chrome.storage.local.set({ settings });
      const m = $('savedMark');
      m.textContent = '✓ сохранено';
      m.className = 'saved show good';
      setTimeout(() => m.classList.remove('show'), 1200);
      refreshStatus();
    } catch (e) {
      const m = $('savedMark');
      m.textContent = e.message;
      m.className = 'saved show bad';
    }
  }

  // ------------------------------------------------------------ status
  function renderWs(state, error) {
    $('wsDot').className = `dot ${state}`;
    const labels = { connected: 'WS online', connecting: 'WS…', disconnected: 'WS offline', error: 'WS offline', disabled: 'WS off' };
    $('wsText').textContent = labels[state] || state;
    $('wsStatus').title = error ? `${error} — нажмите для переподключения` : 'Нажмите для переподключения';
  }
  async function refreshStatus() {
    const r = await send({ type: 'GET_STATUS' });
    if (r && r.ok) {
      renderWs(r.ws.state, r.ws.error);
      $('rpcInfo').textContent = `RPC: ${r.rpc.replace(/^https:\/\//, '').slice(0, 48)}`;
    }
  }
  $('wsStatus').addEventListener('click', async () => {
    renderWs('connecting');
    await send({ type: 'WS_RECONNECT' });
    setTimeout(refreshStatus, 800);
  });

  // ------------------------------------------------------------ scan current tab
  $('scanTab').addEventListener('click', async () => {
    const msg = $('scanTabMsg');
    msg.textContent = '…';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) throw new Error('Нет активной вкладки');
      let res = await chrome.tabs.sendMessage(tab.id, { type: 'FORCE_ANALYZE' }).catch(() => null);
      if (!res) {
        // Content script not present (tab opened before install / unsupported site): inject via activeTab.
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['engine.js', 'ui-overlay.js', 'content.js'] });
        res = await chrome.tabs.sendMessage(tab.id, { type: 'FORCE_ANALYZE' }).catch(() => null);
      }
      if (!res || !res.ok) throw new Error((res && res.error) || 'CA не найден на странице');
      msg.innerHTML = `<span class="good">HUD запущен для ${esc(S.shortAddr(res.address))}</span>`;
      $('caInput').value = res.address;
      checkCa(res.address);
    } catch (e) {
      msg.innerHTML = `<span class="bad">${esc(e.message || e)}</span>`;
    }
  });

  async function checkCa(addr) {
    const box = $('caResult');
    if (!S.isBase58Address(addr)) {
      box.innerHTML = '<span class="bad">Невалидный Solana адрес</span>';
      return;
    }
    box.innerHTML = '<span class="mute">Анализ…</span>';
    const r = await send({ type: 'ANALYZE', address: addr, kind: 'unknown', force: true });
    if (!r || !r.ok) {
      box.innerHTML = `<span class="bad">${esc((r && r.error) || 'Ошибка')}</span>`;
      return;
    }
    const t = r.token;
    const ev = r.evaluation;
    const calc = S.calcPosition({
      deposit: settings.depositAmount, currency: settings.depositCurrency, riskPct: settings.riskPct,
      solUsd: t.solUsd, priceUsd: t.priceUsd, marketCap: t.marketCap, tpMultiple: settings.tpMultiple, tpSellPct: settings.tpSellPct,
    });
    const onOff = (v) => (v == null ? '<span class="mute">n/a</span>' : v ? '<span class="bad">ON</span>' : '<span class="good">OFF</span>');
    box.innerHTML = `
      <div class="row">
        <b>$${esc(t.symbol)}</b><span class="badge ${esc(r.badge.level)}">${esc(r.badge.level)}</span>
        <span class="grow"></span>
        <b class="${ev.score >= settings.minScore ? 'good' : 'bad'}">${ev.score}/100</b>
      </div>
      <div class="kvs">
        <div><span>Mint</span>${onOff(t.mintAuthority)}</div>
        <div><span>Freeze</span>${onOff(t.freezeAuthority)}</div>
        <div><span>LP</span>${t.isBondingCurve ? 'CURVE' : esc(S.fmtPct(t.lpBurnedPct, 0))}</div>
        <div><span>Top 10</span>${esc(S.fmtPct(t.top10Pct))}</div>
        <div><span>Dev</span>${esc(S.fmtPct(t.devPct))}</div>
        <div><span>MC</span>${esc(S.fmtUsd(t.marketCap))}</div>
        <div><span>Vol 5m</span>${esc(S.fmtUsd(t.vol5m))}</div>
        <div><span>Liq</span>${esc(S.fmtUsd(t.liquidityUsd))}</div>
        <div><span>Vol/MC</span>${ev.volMcRatio == null ? 'n/a' : ev.volMcRatio.toFixed(2)}</div>
      </div>
      ${calc ? `<div class="hint">Позиция <b>${esc(S.fmtUsd(calc.positionUsd))}</b> (${esc(S.fmtSol(calc.positionSol))}) · TP ${calc.tpSellPct}% @ ${calc.tpMultiple}x → <b class="good">${esc(S.fmtPrice(calc.tpPriceUsd))}</b> / MC ${esc(S.fmtUsd(calc.tpMarketCap))}</div>` : ''}
      ${r.filter.approved ? '<div class="good">✓ Проходит фильтр сигналов</div>' : `<div class="warn">✗ ${esc(r.filter.reasons.join(' · '))}</div>`}
      <div class="row">
        <a class="btn sm" href="${safeUrl(t.links.photon)}" target="_blank">Open in Photon</a>
        <a class="btn sm" href="${safeUrl(t.links.dexscreener)}" target="_blank">Open in DEXScreener</a>
      </div>`;
  }
  $('caCheck').addEventListener('click', () => checkCa($('caInput').value.trim()));
  $('caInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') checkCa($('caInput').value.trim()); });

  // ------------------------------------------------------------ signals log
  function renderLog() {
    const showRej = $('showRejected').checked;
    const items = log.filter((e) => showRej || e.approved);
    $('sigCount').textContent = log.filter((e) => e.approved).length ? `(${log.filter((e) => e.approved).length})` : '';
    if (!items.length) {
      $('log').innerHTML = `<div class="empty">${showRej ? 'Сигналов пока нет' : 'Нет одобренных сигналов'}<br><span class="hint">Запустите server.py и подключитесь к ${esc(settings.wsUrl)}</span></div>`;
      return;
    }
    $('log').innerHTML = items.map((e) => `
      <div class="sig ${e.approved ? '' : 'rej'}">
        <div class="top">
          <span class="sym">$${esc(e.symbol)}</span>
          <span class="badge ${esc(e.badge)}">${esc(e.badge)}</span>
          <b class="${e.approved ? 'good' : 'bad'}">${esc(e.score)}</b>
          <span class="grow"></span>
          <span class="meta">${esc(new Date(e.ts).toLocaleTimeString())}</span>
        </div>
        <div class="meta">MC ${esc(S.fmtUsd(e.marketCap))} · Vol5m ${esc(S.fmtUsd(e.vol5m))} · Top10 ${esc(S.fmtPct(e.top10Pct))} · ${esc(e.channel)}</div>
        ${e.approved ? '' : `<div class="meta bad">${esc((e.reasons || []).join(' · '))}</div>`}
        <div class="actions">
          <a class="btn sm" href="${safeUrl(e.links && e.links.photon)}" target="_blank">Open in Photon</a>
          <a class="btn sm" href="${safeUrl(e.links && e.links.dexscreener)}" target="_blank">Open in DEXScreener</a>
          <button class="btn ghost sm" data-copy="${esc(e.mint)}">Copy CA</button>
        </div>
      </div>`).join('');
  }
  $('log').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-copy]');
    if (!b) return;
    navigator.clipboard.writeText(b.dataset.copy).then(() => { b.textContent = '✓'; }).catch(() => {});
  });
  $('showRejected').addEventListener('change', renderLog);
  $('clearLog').addEventListener('click', async () => {
    await send({ type: 'CLEAR_LOG' });
    log = [];
    renderLog();
  });
  $('testSignal').addEventListener('click', async () => {
    const a = $('testCa').value.trim();
    if (!S.isBase58Address(a)) { $('testCa').style.borderColor = 'var(--bad)'; return; }
    $('testCa').style.borderColor = '';
    $('testSignal').textContent = '…';
    const r = await send({ type: 'TEST_SIGNAL', address: a });
    $('testSignal').textContent = 'Test';
    if (r && r.ok && r.entry && !r.entry.approved) $('showRejected').checked = true;
    renderLog();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SIGNAL_LOGGED') {
      log = [msg.entry, ...log.filter((e) => e.id !== msg.entry.id)].slice(0, 100);
      renderLog();
    } else if (msg.type === 'WS_STATE') {
      renderWs(msg.state, msg.error);
    }
  });

  // ------------------------------------------------------------ init
  (async () => {
    const { settings: stored } = await chrome.storage.local.get('settings');
    settings = { ...S.DEFAULT_SETTINGS, ...(stored || {}) };
    fillForm();
    const r = await send({ type: 'GET_LOG' });
    log = (r && r.log) || [];
    renderLog();
    refreshStatus();
  })();
})();
