/* SolSniper content script: detects the token CA on the page and drives the HUD. */
(function () {
  'use strict';
  if (globalThis.__solsniperLoaded) return;
  globalThis.__solsniperLoaded = true;

  const S = globalThis.SolSniper;
  const REFRESH_MS = 15_000;
  const URL_POLL_MS = 700;

  /** @returns {{address:string, kind:'mint'|'pair'|'unknown'} | null} */
  function detectFromUrl(href) {
    let u;
    try { u = new URL(href); } catch (_) { return null; }
    const host = u.hostname.replace(/^www\./, '');
    const seg = u.pathname.split('/').filter(Boolean);
    const pick = (s) => (s && S.isBase58Address(s) ? s : null);
    const lastB58 = (str) => {
      const found = S.extractAddresses(str || '', 5);
      return found.length ? found[found.length - 1] : null;
    };

    if (host === 'dexscreener.com') {
      // /solana/<pairAddress>  (DexScreener also accepts a mint here)
      // kind 'pair': background falls back to treating it as a mint if no pair matches.
      if (seg[0] === 'solana') return pick(seg[1]) ? { address: seg[1], kind: 'pair' } : null;
      return null;
    }
    if (host === 'pump.fun' || host.endsWith('.pump.fun')) {
      const a = seg[0] === 'coin' ? pick(seg[1]) : pick(seg[0]);
      return a ? { address: a, kind: 'mint' } : null;
    }
    if (host === 'photon-sol.tinyastro.io') {
      const i = seg.indexOf('lp');
      if (i >= 0 && pick(seg[i + 1])) return { address: seg[i + 1], kind: 'pair' };
      const q = pick(u.searchParams.get('address'));
      return q ? { address: q, kind: 'unknown' } : null;
    }
    if (host === 'bullx.io' || host.endsWith('.bullx.io')) {
      const q = pick(u.searchParams.get('address'));
      return q ? { address: q, kind: 'unknown' } : null;
    }
    if (host === 'gmgn.ai') {
      // /sol/token/<mint> or /sol/token/<ref>_<mint>
      if (seg[0] === 'sol' && seg[1] === 'token') {
        const a = lastB58((seg[2] || '').replace(/_/g, ' '));
        return a ? { address: a, kind: 'mint' } : null;
      }
      return null;
    }
    if (host === 'axiom.trade') {
      const a = seg[0] === 'meme' ? pick(seg[1]) : null;
      return a ? { address: a, kind: 'pair' } : null;
    }
    // Generic (popup-injected on any site): any base58 path segment or ?address=
    const q = pick(u.searchParams.get('address')) || pick(u.searchParams.get('token')) || pick(u.searchParams.get('mint'));
    if (q) return { address: q, kind: 'unknown' };
    const s = seg.map(pick).find(Boolean);
    return s ? { address: s, kind: 'unknown' } : null;
  }

  /** Fallback: explorer / rugcheck links rendered on the page usually point at the mint. */
  function detectFromDom() {
    const sel = [
      'a[href*="solscan.io/token/"]',
      'a[href*="rugcheck.xyz/tokens/"]',
      'a[href*="birdeye.so/token/"]',
      'a[href*="pump.fun/coin/"]',
    ].join(',');
    for (const a of document.querySelectorAll(sel)) {
      const m = S.extractAddresses(a.getAttribute('href') || '', 2).find(S.isBase58Address);
      if (m) return { address: m, kind: 'mint' };
    }
    return null;
  }

  function detect() {
    return detectFromUrl(location.href) || detectFromDom();
  }

  // ------------------------------------------------------------ controller
  let settings = { ...S.DEFAULT_SETTINGS };
  let current = null;       // { address, kind }
  let reqSeq = 0;
  let refreshTimer = null;
  let dismissed = false;
  let overlay = null;

  function ensureOverlay() {
    if (dismissed) return null;
    if (!overlay) {
      overlay = globalThis.SolSniperOverlay.create({
        onRefresh: () => analyze(true),
        onClose: () => { dismissed = true; overlay = null; stopRefresh(); },
        onSettingsChange: async (patch) => {
          try {
            const { settings: stored } = await chrome.storage.local.get('settings');
            await chrome.storage.local.set({ settings: { ...S.DEFAULT_SETTINGS, ...(stored || {}), ...patch } });
          } catch (e) { /* extension reloaded */ }
        },
      });
      overlay.setSettings(settings);
    } else {
      overlay.reattach();
    }
    return overlay;
  }

  async function analyze(force = false) {
    if (!current) return;
    const ui = ensureOverlay();
    if (!ui) return;
    const seq = ++reqSeq;
    const target = current;
    ui.setState({ status: 'loading', address: target.address });
    try {
      const res = await chrome.runtime.sendMessage({ type: 'ANALYZE', address: target.address, kind: target.kind, force });
      if (seq !== reqSeq) return; // stale: user navigated to another token
      if (!res || !res.ok) throw new Error((res && res.error) || 'No response');
      ui.setState({ status: 'ready', address: target.address, result: res, error: null });
    } catch (e) {
      if (seq !== reqSeq) return;
      const msg = String(e.message || e);
      ui.setState({ status: 'error', address: target.address, error: /context invalidated/i.test(msg) ? 'Расширение обновлено — перезагрузите страницу' : msg });
    }
  }

  function startRefresh() {
    stopRefresh();
    if (!settings.autoCheck) return;
    refreshTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && current && !dismissed) analyze(false);
    }, REFRESH_MS);
  }
  function stopRefresh() { clearInterval(refreshTimer); refreshTimer = null; }

  function onLocationMaybeChanged() {
    const found = detect();
    const same = found && current && found.address === current.address;
    if (same) return;
    current = found;
    if (!found) {
      if (overlay) overlay.setState({ status: 'idle', address: null });
      stopRefresh();
      return;
    }
    dismissed = false; // a new token re-opens the HUD
    if (settings.autoCheck) {
      analyze(false);
      startRefresh();
    } else {
      const ui = ensureOverlay();
      if (ui) ui.setState({ status: 'nocheck', address: found.address });
    }
  }

  // SPA navigation: page-world history.pushState is invisible to content scripts → poll href cheaply,
  // plus a debounced MutationObserver for the DOM fallback on pages whose URL has no CA.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      onLocationMaybeChanged();
    }
  }, URL_POLL_MS);

  let moTimer = null;
  const mo = new MutationObserver(() => {
    if (current) return;
    clearTimeout(moTimer);
    moTimer = setTimeout(onLocationMaybeChanged, 500);
  });

  // ------------------------------------------------------------ wiring
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const prevAuto = settings.autoCheck;
    settings = { ...S.DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    if (overlay) overlay.setSettings(settings);
    if (prevAuto !== settings.autoCheck) {
      if (settings.autoCheck && current) { analyze(false); startRefresh(); }
      else stopRefresh();
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'FORCE_ANALYZE') {
      dismissed = false;
      current = detect() || current;
      if (!current) { sendResponse({ ok: false, error: 'CA не найден на странице' }); return false; }
      analyze(true);
      sendResponse({ ok: true, address: current.address });
    }
    return false;
  });

  (async function init() {
    try {
      const { settings: stored } = await chrome.storage.local.get('settings');
      settings = { ...S.DEFAULT_SETTINGS, ...(stored || {}) };
    } catch (_) { /* defaults */ }
    mo.observe(document.documentElement, { childList: true, subtree: true });
    onLocationMaybeChanged();
  })();
})();
