/* SolSniper floating HUD — isolated in a closed Shadow DOM. Exposes globalThis.SolSniperOverlay. */
(function () {
  'use strict';
  if (globalThis.SolSniperOverlay) return;
  const S = globalThis.SolSniper;

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : '#');
  const isMobile = () => window.matchMedia('(max-width: 640px), (pointer: coarse) and (max-width: 900px)').matches;

  const SKELETON = `
    <div class="pill" part="pill" hidden>
      <span class="pill-dot"></span><span class="pill-text">SolSniper</span>
    </div>
    <section class="panel" role="dialog" aria-label="SolSniper HUD">
      <header class="hdr">
        <div class="brand"><svg class="logo-mark" viewBox="60 60 392 392" aria-hidden="true"><circle cx="256" cy="256" r="146" fill="none" stroke="#fff" stroke-width="26" stroke-dasharray="185.3 44" stroke-dashoffset="-22"/><path d="M256 84V164M256 348V428M84 256H164M348 256H428" stroke="#fff" stroke-width="18"/><rect x="232" y="232" width="48" height="48" fill="#fff" transform="rotate(45 256 256)"/></svg><span class="title"><b>SOL</b><span>SNIPER</span></span></div>
        <div class="hdr-info"></div>
        <div class="hdr-actions">
          <button class="icon-btn" data-act="refresh" title="Обновить">↻</button>
          <button class="icon-btn" data-act="min" title="Свернуть">–</button>
          <button class="icon-btn" data-act="close" title="Закрыть">×</button>
        </div>
      </header>
      <div class="body"></div>
      <div class="calc">
        <div class="sec-title">Risk Calc</div>
        <div class="calc-in">
          <label class="field"><span>Депозит</span><input data-k="depositAmount" type="number" inputmode="decimal" min="0" step="any"></label>
          <label class="field field-sm"><span>Валюта</span>
            <select data-k="depositCurrency"><option value="USD">USD</option><option value="SOL">SOL</option></select></label>
          <label class="field field-sm"><span>Риск %</span><input data-k="riskPct" type="number" inputmode="decimal" min="0.1" max="100" step="0.1"></label>
        </div>
        <div class="calc-out"></div>
      </div>
      <footer class="ftr"></footer>
    </section>`;

  function create(handlers) {
    const host = document.createElement('div');
    host.id = 'solsniper-hud-host';
    host.setAttribute('style', 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;');
    const shadow = host.attachShadow({ mode: 'closed' });

    // Constructable stylesheet ignores page CSP; <style> fallback for older engines.
    fetch(chrome.runtime.getURL('styles.css'))
      .then((r) => r.text())
      .then((css) => {
        try {
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(css);
          shadow.adoptedStyleSheets = [sheet];
        } catch (_) {
          const st = document.createElement('style');
          st.textContent = css;
          shadow.prepend(st);
        }
      })
      .catch((e) => console.warn('[SolSniper] css load failed', e));

    const wrap = document.createElement('div');
    wrap.className = 'root';
    wrap.innerHTML = SKELETON;
    shadow.appendChild(wrap);

    // Keep page hotkeys (Photon/BullX trade shortcuts) from firing while typing in the HUD.
    for (const t of ['keydown', 'keyup', 'keypress']) host.addEventListener(t, (e) => e.stopPropagation());

    const $ = (sel) => wrap.querySelector(sel);
    const panel = $('.panel');
    const pill = $('.pill');
    let state = { status: 'idle' };
    let prefs = { minimized: false, pos: null };
    let calcSettings = { ...S.DEFAULT_SETTINGS };

    // ---------- persistence of position / minimized state
    chrome.storage.local.get('overlayState').then(({ overlayState }) => {
      prefs = { ...prefs, ...(overlayState || {}) };
      applyLayout();
    }).catch(() => {});
    const savePrefs = () => chrome.storage.local.set({ overlayState: prefs }).catch(() => {});

    function applyLayout() {
      panel.hidden = prefs.minimized;
      pill.hidden = !prefs.minimized;
      wrap.classList.toggle('mobile', isMobile());
      if (isMobile() || !prefs.pos) {
        host.style.left = host.style.top = '';
        host.style.right = isMobile() ? '0' : '16px';
        host.style.bottom = isMobile() ? '0' : '16px';
        if (isMobile() && !prefs.minimized) host.style.left = '0';
        if (isMobile() && prefs.minimized) { host.style.right = '12px'; host.style.bottom = '12px'; }
        return;
      }
      const r = host.getBoundingClientRect();
      const x = Math.min(Math.max(0, prefs.pos.x), Math.max(0, window.innerWidth - (r.width || 320)));
      const y = Math.min(Math.max(0, prefs.pos.y), Math.max(0, window.innerHeight - 48));
      host.style.right = host.style.bottom = '';
      host.style.left = `${x}px`;
      host.style.top = `${y}px`;
    }
    window.addEventListener('resize', applyLayout, { passive: true });

    // ---------- drag (desktop only; pointer events also cover touch)
    $('.hdr').addEventListener('pointerdown', (e) => {
      if (isMobile() || e.target.closest('button')) return;
      const r = host.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      const hdr = e.currentTarget;
      hdr.setPointerCapture(e.pointerId);
      const move = (ev) => {
        prefs.pos = { x: ev.clientX - dx, y: ev.clientY - dy };
        applyLayout();
      };
      const up = () => {
        hdr.removeEventListener('pointermove', move);
        hdr.removeEventListener('pointerup', up);
        savePrefs();
      };
      hdr.addEventListener('pointermove', move);
      hdr.addEventListener('pointerup', up);
    });

    // ---------- actions
    wrap.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (btn) {
        const act = btn.dataset.act;
        if (act === 'min') { prefs.minimized = true; savePrefs(); applyLayout(); }
        else if (act === 'close') { host.remove(); handlers.onClose && handlers.onClose(); }
        else if (act === 'refresh' || act === 'check') handlers.onRefresh && handlers.onRefresh();
        else if (act === 'copy' && state.result) {
          navigator.clipboard.writeText(state.result.token.mint).then(() => flash(btn, '✓ copied')).catch(() => {});
        }
        return;
      }
      if (e.target.closest('.pill')) { prefs.minimized = false; savePrefs(); applyLayout(); }
    });

    function flash(el, text) {
      const old = el.textContent;
      el.textContent = text;
      setTimeout(() => { el.textContent = old; }, 900);
    }

    // ---------- calculator inputs
    let calcTimer = null;
    wrap.querySelectorAll('.calc [data-k]').forEach((input) => {
      input.addEventListener('input', () => {
        const k = input.dataset.k;
        calcSettings[k] = input.tagName === 'SELECT' ? input.value : parseFloat(input.value);
        renderCalc();
        clearTimeout(calcTimer);
        calcTimer = setTimeout(() => handlers.onSettingsChange && handlers.onSettingsChange({
          depositAmount: calcSettings.depositAmount,
          depositCurrency: calcSettings.depositCurrency,
          riskPct: calcSettings.riskPct,
        }), 400);
      });
    });

    function syncCalcInputs() {
      wrap.querySelectorAll('.calc [data-k]').forEach((input) => {
        if (shadow.activeElement === input) return;
        const v = calcSettings[input.dataset.k];
        input.value = v == null || Number.isNaN(v) ? '' : v;
      });
    }

    // ---------- rendering
    const kv = (label, value, cls = '') => `<div class="kv ${cls}"><span class="k">${esc(label)}</span><span class="v">${value}</span></div>`;
    const onOff = (v, goodWhenOff = true) => {
      if (v === null || v === undefined) return '<span class="chip chip-mute">n/a</span>';
      const bad = goodWhenOff ? v : !v;
      return `<span class="chip ${bad ? 'chip-bad' : 'chip-good'}">${v ? 'ON' : 'OFF'}</span>`;
    };
    const threshold = (v, warnAt, badAt, fmt = (x) => S.fmtPct(x)) => {
      if (S.num(v) === null) return '<span class="mute">n/a</span>';
      const cls = v >= badAt ? 'bad' : v >= warnAt ? 'warn' : 'good';
      return `<span class="${cls}">${esc(fmt(v))}</span>`;
    };

    function renderHeader() {
      const h = $('.hdr-info');
      if (state.status !== 'ready') {
        h.innerHTML = state.address ? `<span class="addr">${esc(S.shortAddr(state.address))}</span>` : '';
        return;
      }
      const { token, evaluation } = state.result;
      const sc = evaluation.score;
      h.innerHTML = `
        <span class="sym" title="${esc(token.name)}">$${esc(token.symbol)}</span>
        <button class="addr" data-act="copy" title="Скопировать CA">${esc(S.shortAddr(token.mint))}</button>
        <span class="score ${sc >= 70 ? 'good' : sc >= 40 ? 'warn' : 'bad'}">${sc}</span>`;
    }

    function renderBody() {
      const b = $('.body');
      if (state.status === 'idle') {
        b.innerHTML = '<div class="empty">Откройте страницу токена Solana — CA определится автоматически.</div>';
        return;
      }
      if (state.status === 'nocheck') {
        b.innerHTML = `<div class="empty">Авто-проверка выключена.<br><button class="btn" data-act="check">Проверить ${esc(S.shortAddr(state.address))}</button></div>`;
        return;
      }
      if (state.status === 'loading' && !state.result) {
        b.innerHTML = '<div class="loading"><span class="spinner"></span>RugCheck · DexScreener · RPC…</div>';
        return;
      }
      if (state.status === 'error' && !state.result) {
        b.innerHTML = `<div class="empty bad">Ошибка: ${esc(state.error)}<br><button class="btn" data-act="check">Повторить</button></div>`;
        return;
      }
      const { token: t, evaluation: ev, badge, filter } = state.result;
      const lp = t.isBondingCurve
        ? '<span class="chip chip-good" title="pump.fun bonding curve: ликвидность в программе">CURVE</span>'
        : threshold(t.lpBurnedPct === null ? null : 100 - t.lpBurnedPct, 1, 50, () => `${t.lpBurnedPct.toFixed(0)}%`);
      const risks = badge.reasons.length
        ? `<details class="risks"><summary>${badge.reasons.length} флаг(ов) риска</summary><ul>${badge.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></details>`
        : '';
      b.innerHTML = `
        <div class="badge-row">
          <span class="badge badge-${badge.level.toLowerCase()}">${badge.level}</span>
          <span class="verdict ${ev.passed ? 'good' : 'bad'}">${ev.passed ? 'PASS' : 'HIGH RUG RISK'}</span>
          ${state.status === 'loading' ? '<span class="spinner sm"></span>' : ''}
        </div>
        <div class="grid">
          <div class="card">
            <div class="sec-title">RugCheck</div>
            ${kv('Mint', onOff(t.mintAuthority))}
            ${kv('Freeze', onOff(t.freezeAuthority))}
            ${kv('LP burn', lp)}
          </div>
          <div class="card">
            <div class="sec-title">Holders</div>
            ${kv('Top 10', threshold(t.top10Pct, 15, 30))}
            ${kv('Dev', threshold(t.devPct, 5, 10))}
            ${kv('Holders', esc(t.totalHolders ?? 'n/a'))}
          </div>
          <div class="card">
            <div class="sec-title">Market</div>
            ${kv('MC', esc(S.fmtUsd(t.marketCap)))}
            ${kv('Vol 5m', esc(S.fmtUsd(t.vol5m)))}
            ${kv('Liq', esc(S.fmtUsd(t.liquidityUsd)))}
          </div>
        </div>
        <div class="score-box">
          <div class="bar"><div class="bar-fill ${ev.score >= 70 ? 'good' : ev.score >= 40 ? 'warn' : 'bad'}" style="width:${ev.score}%"></div></div>
          <ul class="breakdown">
            ${ev.breakdown.map((r) => `<li class="${r.ok ? 'good' : 'mute'}"><span>${r.ok ? '✓' : '✗'} ${esc(r.label)}</span><span>${esc(r.detail)} · +${r.points}</span></li>`).join('')}
          </ul>
        </div>
        ${!filter.approved ? `<div class="filter-note">Фильтр сигналов: ${esc(filter.reasons.join(' · '))}</div>` : ''}
        ${risks}`;
    }

    function renderCalc() {
      const out = $('.calc-out');
      const calc = $('.calc');
      if (state.status !== 'ready' && !state.result) { calc.hidden = true; return; }
      calc.hidden = false;
      const t = state.result.token;
      const c = S.calcPosition({
        deposit: calcSettings.depositAmount,
        currency: calcSettings.depositCurrency,
        riskPct: calcSettings.riskPct,
        solUsd: t.solUsd,
        priceUsd: t.priceUsd,
        marketCap: t.marketCap,
        tpMultiple: calcSettings.tpMultiple,
        tpSellPct: calcSettings.tpSellPct,
      });
      if (!c) { out.innerHTML = '<div class="mute">Введите депозит и риск %</div>'; return; }
      out.innerHTML = `
        ${kv('Позиция', `<b>${esc(S.fmtUsd(c.positionUsd))}</b> <span class="mute">${esc(S.fmtSol(c.positionSol))}</span>`)}
        ${kv(`TP ${c.tpSellPct}% @ ${c.tpMultiple}x`, `<b class="good">${esc(S.fmtPrice(c.tpPriceUsd))}</b>`)}
        ${kv('TP Market Cap', esc(S.fmtUsd(c.tpMarketCap)))}
        ${kv('Вывод на TP', `${esc(S.fmtUsd(c.sellValueUsd))} <span class="mute">(тело)</span>`)}`;
    }

    function renderFooter() {
      const f = $('.ftr');
      if (!state.result) { f.innerHTML = ''; return; }
      const { token: t } = state.result;
      const dot = (ok, name) => `<span class="src ${ok ? 'ok' : 'fail'}" title="${esc(name)}${ok ? '' : ': ' + esc(t.errors[name === 'RPC' ? 'rpc' : name.toLowerCase()] || 'no data')}">${esc(name)}</span>`;
      f.innerHTML = `
        <div class="links">
          <a href="${safeUrl(t.links.photon)}" target="_blank" rel="noopener">Photon</a>
          <a href="${safeUrl(t.links.dexscreener)}" target="_blank" rel="noopener">DEX</a>
          <a href="${safeUrl(t.links.rugcheck)}" target="_blank" rel="noopener">RugCheck</a>
          ${t.socials.twitter ? `<a href="${safeUrl(t.socials.twitter)}" target="_blank" rel="noopener">𝕏</a>` : ''}
        </div>
        <div class="srcs">${dot(t.sources.dexscreener, 'DexScreener')}${dot(t.sources.rugcheck, 'RugCheck')}${dot(t.sources.rpc, 'RPC')}
          <span class="mute">${new Date(t.fetchedAt).toLocaleTimeString()}</span></div>`;
    }

    function renderPill() {
      const txt = $('.pill-text');
      const d = $('.pill-dot');
      if (state.result) {
        txt.textContent = `$${state.result.token.symbol} · ${state.result.evaluation.score}`;
        d.className = `pill-dot ${state.result.badge.level.toLowerCase()}`;
      } else {
        txt.textContent = state.status === 'loading' ? 'SolSniper…' : 'SolSniper';
        d.className = 'pill-dot';
      }
    }

    function render() {
      renderHeader();
      renderBody();
      renderCalc();
      renderFooter();
      renderPill();
    }

    (document.body || document.documentElement).appendChild(host);
    render();
    applyLayout();

    return {
      setState(next) {
        // Keep the last good result visible while a refresh for the same token runs.
        const sameToken = !next.address || next.address === state.address;
        if (!('result' in next)) {
          next = { ...next, result: sameToken && next.status !== 'idle' && next.status !== 'nocheck' ? state.result : null };
        }
        state = { ...state, ...next };
        render();
      },
      setSettings(s) {
        calcSettings = { ...S.DEFAULT_SETTINGS, ...s };
        syncCalcInputs();
        renderCalc();
      },
      isAttached: () => host.isConnected,
      reattach() {
        if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
      },
    };
  }

  globalThis.SolSniperOverlay = { create };
})();
