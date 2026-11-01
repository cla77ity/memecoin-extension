/**
 * SolSniper engine — shared by the service worker (importScripts), content scripts and popup.
 * Pure functions only: no chrome.* APIs, no network. Exposes `globalThis.SolSniper`.
 */
(function (root) {
  'use strict';

  const DEFAULT_SETTINGS = Object.freeze({
    autoCheck: true,
    maxTop10Pct: 20,        // hard filter: Top-10 holders must be <= this
    minVol5mUsd: 30000,     // hard filter: 5m volume must be >= this
    minScore: 70,           // below this a token is "HIGH RUG RISK"
    depositAmount: 1000,
    depositCurrency: 'USD', // 'USD' | 'SOL'
    riskPct: 2,             // % of deposit per position
    tpMultiple: 2,          // take profit at Nx
    tpSellPct: 50,          // sell this % of the bag at TP
    heliusApiKey: '',
    rpcUrl: '',             // custom RPC overrides Helius / public RPC
    wsUrl: 'ws://localhost:8080',
    wsEnabled: true,
    notifyEnabled: true,
    liveEnabled: false,     // live scanner of every new launch
    minLiqUsd: 10000,
    watchMinutes: 30,
    maxChecksPerMin: 6,
    liveMigrationsOnly: false,
    keepAwake: true,
    wallets: [],            // [{ address, label }] tracked trader / KOL wallets
    walletNotify: true,
    soundEnabled: true,
  });

  const WSOL = 'So11111111111111111111111111111111111111112';
  const IGNORED_MINTS = new Set([
    WSOL,
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF8H2wpcqiS1Ycd9sUYyAdYafMoPj', // USDT
    '11111111111111111111111111111111',
  ]);

  // Owners whose token accounts are liquidity pools / burn sinks, not holders.
  const KNOWN_POOL_OWNERS = new Set([
    '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium AMM v4 authority
    'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL', // Raydium CPMM authority
    '1nc1nerator11111111111111111111111111111111',  // incinerator
  ]);

  const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const BASE58_SCAN_RE = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;

  const isBase58Address = (s) => typeof s === 'string' && BASE58_RE.test(s) && !IGNORED_MINTS.has(s);

  function extractAddresses(text, limit = 5) {
    if (typeof text !== 'string') return [];
    const out = [];
    for (const m of text.matchAll(BASE58_SCAN_RE)) {
      if (isBase58Address(m[0]) && !out.includes(m[0])) out.push(m[0]);
      if (out.length >= limit) break;
    }
    return out;
  }

  const num = (v) => {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return Number.isFinite(n) ? n : null;
  };

  function isActiveTwitterLink(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, '').replace(/^mobile\./, '');
      if (host !== 'x.com' && host !== 'twitter.com') return false;
      const path = u.pathname.replace(/\/+$/, '');
      if (!path || /^\/(search|intent|share|home|explore)(\/|$)/i.test(path)) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Attention / safety score (0-100).
   *  +40  LP 100% burned (or pump.fun bonding curve — liquidity held by program) AND mint authority disabled
   *  +20  Top-10 holders < 15%
   *  +20  Volume 5m / MarketCap > 0.2
   *  +20  Active X/Twitter link
   * Unknown data never earns points.
   */
  function evaluateTokenPotential(t, opts = {}) {
    const minScore = num(opts.minScore) ?? DEFAULT_SETTINGS.minScore;
    const lpOk = t.isBondingCurve === true || (num(t.lpBurnedPct) !== null && t.lpBurnedPct >= 99);
    const mintOff = t.mintAuthority === false;
    const top10 = num(t.top10Pct);
    const vol5m = num(t.vol5m);
    const mc = num(t.marketCap);
    const ratio = vol5m !== null && mc ? vol5m / mc : null;
    const twitter = isActiveTwitterLink(t.socials && t.socials.twitter);

    const lpLabel = t.isBondingCurve ? 'Bonding curve' : (num(t.lpBurnedPct) !== null ? `${t.lpBurnedPct.toFixed(0)}%` : 'n/a');
    const breakdown = [
      {
        key: 'lp_mint', label: 'LP burned + Mint OFF', max: 40, ok: lpOk && mintOff,
        detail: `LP ${lpLabel} · Mint ${t.mintAuthority === null || t.mintAuthority === undefined ? 'n/a' : (mintOff ? 'OFF' : 'ON')}`,
      },
      { key: 'top10', label: 'Top 10 < 15%', max: 20, ok: top10 !== null && top10 < 15, detail: top10 === null ? 'n/a' : `${top10.toFixed(1)}%` },
      { key: 'vol_mc', label: 'Vol5m / MC > 0.2', max: 20, ok: ratio !== null && ratio > 0.2, detail: ratio === null ? 'n/a' : ratio.toFixed(2) },
      { key: 'twitter', label: 'Active X link', max: 20, ok: twitter, detail: twitter ? 'yes' : 'no' },
    ].map((r) => ({ ...r, points: r.ok ? r.max : 0 }));

    const score = breakdown.reduce((s, r) => s + r.points, 0);
    return {
      score,
      breakdown,
      volMcRatio: ratio,
      passed: score >= minScore,
      verdict: score >= minScore ? 'PASS' : 'HIGH RUG RISK',
    };
  }

  /** SAFE / WARNING / DANGER badge for the HUD. */
  function classifyRisk(t, evaluation, settings = DEFAULT_SETTINGS) {
    const danger = [];
    const warn = [];
    if (t.mintAuthority === true) danger.push('Mint authority enabled');
    if (t.freezeAuthority === true) danger.push('Freeze authority enabled');
    if (!t.isBondingCurve && num(t.lpBurnedPct) !== null && t.lpBurnedPct < 50) danger.push(`LP only ${t.lpBurnedPct.toFixed(0)}% burned/locked`);
    if (num(t.top10Pct) !== null && t.top10Pct > 50) danger.push(`Top 10 hold ${t.top10Pct.toFixed(0)}%`);
    if (num(t.devPct) !== null && t.devPct > 20) danger.push(`Dev holds ${t.devPct.toFixed(0)}%`);
    for (const r of (t.rugRisks || [])) {
      if (r.level === 'danger') danger.push(r.name);
      else if (r.level === 'warn') warn.push(r.name);
    }
    if (evaluation && !evaluation.passed) warn.push(`Score ${evaluation.score} < ${settings.minScore}`);
    if (num(t.top10Pct) !== null && t.top10Pct > settings.maxTop10Pct) warn.push(`Top 10 > ${settings.maxTop10Pct}%`);
    if (t.mintAuthority == null || t.freezeAuthority == null) warn.push('Authorities unknown');

    const level = danger.length ? 'DANGER' : (warn.length ? 'WARNING' : 'SAFE');
    return { level, reasons: [...new Set([...danger, ...warn])] };
  }

  /** Hard signal filter used for Telegram signals. */
  function applySignalFilter(t, settings = DEFAULT_SETTINGS) {
    const s = { ...DEFAULT_SETTINGS, ...settings };
    const evaluation = evaluateTokenPotential(t, s);
    const badge = classifyRisk(t, evaluation, s);
    const reasons = [];
    if (!evaluation.passed) reasons.push(`HIGH RUG RISK (score ${evaluation.score}/${s.minScore})`);
    if (t.freezeAuthority === true) reasons.push('Freeze authority ON');
    if (num(t.top10Pct) === null) reasons.push('Top 10 unknown');
    else if (t.top10Pct > s.maxTop10Pct) reasons.push(`Top 10 ${t.top10Pct.toFixed(1)}% > ${s.maxTop10Pct}%`);
    if (num(t.vol5m) === null) reasons.push('5m volume unknown');
    else if (t.vol5m < s.minVol5mUsd) reasons.push(`Vol 5m ${fmtUsd(t.vol5m)} < ${fmtUsd(s.minVol5mUsd)}`);
    return { approved: reasons.length === 0, reasons, evaluation, badge };
  }

  /**
   * Position sizing: risk % of deposit, TP sells `tpSellPct`% of the bag at `tpMultiple`x.
   * Selling 50% at 2x returns the initial stake ("free ride").
   */
  function calcPosition({ deposit, currency = 'USD', riskPct, solUsd, priceUsd, marketCap, tpMultiple = 2, tpSellPct = 50 }) {
    const dep = num(deposit);
    const rp = num(riskPct);
    if (dep === null || dep <= 0 || rp === null || rp <= 0) return null;
    const sol = num(solUsd);
    const positionNative = dep * (rp / 100);
    const positionUsd = currency === 'SOL' ? (sol ? positionNative * sol : null) : positionNative;
    const positionSol = currency === 'SOL' ? positionNative : (sol ? positionNative / sol : null);
    const price = num(priceUsd);
    const mult = num(tpMultiple) || 2;
    const sellPct = (num(tpSellPct) ?? 50) / 100;
    const tokens = positionUsd !== null && price ? positionUsd / price : null;
    return {
      positionUsd,
      positionSol,
      tokens,
      tpPriceUsd: price ? price * mult : null,
      tpMarketCap: num(marketCap) ? marketCap * mult : null,
      sellTokens: tokens !== null ? tokens * sellPct : null,
      sellValueUsd: positionUsd !== null ? positionUsd * mult * sellPct : null,
      tpMultiple: mult,
      tpSellPct: sellPct * 100,
    };
  }

  // ---------- formatting ----------
  function fmtUsd(v) {
    const n = num(v);
    if (n === null) return 'n/a';
    const a = Math.abs(n);
    if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
    if (a >= 1) return `$${n.toFixed(2)}`;
    return fmtPrice(n);
  }

  /** $0.0₅1234 style for micro-cap prices. */
  function fmtPrice(v) {
    const n = num(v);
    if (n === null) return 'n/a';
    if (n === 0) return '$0';
    if (n >= 0.01) return `$${n.toPrecision(4).replace(/\.?0+$/, '')}`;
    const s = n.toFixed(20);
    const m = s.match(/^0\.(0+)(\d{1,4})/);
    if (!m) return `$${n.toExponential(3)}`;
    const zeros = m[1].length;
    if (zeros < 4) return `$0.${m[1]}${m[2]}`;
    const sub = String(zeros).split('').map((d) => '₀₁₂₃₄₅₆₇₈₉'[d]).join('');
    return `$0.0${sub}${m[2]}`;
  }

  const fmtPct = (v, d = 1) => (num(v) === null ? 'n/a' : `${num(v).toFixed(d)}%`);
  const fmtSol = (v) => (num(v) === null ? 'n/a' : `${num(v) >= 10 ? num(v).toFixed(1) : num(v).toFixed(3)} SOL`);
  const shortAddr = (a) => (typeof a === 'string' && a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || '');

  // ---------- socials / project profile
  /** Turns a raw social value (URL, handle, bare domain) into a safe https URL, or null. */
  function normalizeSocial(kind, value) {
    if (typeof value !== 'string') return null;
    let v = value.trim();
    if (!v || v.length > 300) return null;
    if (/^http:\/\//i.test(v)) v = `https://${v.slice(7)}`;
    if (!/^https:\/\//i.test(v)) {
      if (kind === 'twitter' && /^@?[A-Za-z0-9_]{1,15}$/.test(v)) return `https://x.com/${v.replace(/^@/, '')}`;
      if (kind === 'telegram' && /^@?[A-Za-z0-9_]{4,32}$/.test(v)) return `https://t.me/${v.replace(/^@/, '')}`;
      if (/^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(v)) v = `https://${v}`;
      else return null;
    }
    try {
      const u = new URL(v);
      return u.protocol === 'https:' ? u.toString().replace(/\/$/, '') : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * What the coin is tied to: own X account, someone else's tweet (narrative coin), X community, website, or nothing.
   * @returns {{kind:string, label:string, handle:string|null, site:string|null, hasAny:boolean}}
   */
  function describeSocials(socials = {}) {
    let kind = 'none';
    let handle = null;
    if (socials.twitter) {
      try {
        const u = new URL(socials.twitter);
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts[1] === 'status') { kind = 'tweet'; handle = parts[0]; }
        else if (parts[0] === 'i' && parts[1] === 'communities') kind = 'community';
        else if (parts[0]) { kind = 'profile'; handle = parts[0]; }
      } catch (_) { /* ignore */ }
    }
    let site = null;
    if (socials.website) { try { site = new URL(socials.website).hostname.replace(/^www\./, ''); } catch (_) { /* ignore */ } }
    const bits = [];
    if (kind === 'profile') bits.push(`свой X-аккаунт @${handle}`);
    if (kind === 'tweet') bits.push(`привязана к твиту @${handle}`);
    if (kind === 'community') bits.push('X-комьюнити');
    if (site) bits.push(`сайт ${site}`);
    if (socials.telegram) bits.push('Telegram');
    const hasAny = bits.length > 0;
    const label = !hasAny ? 'Ни к чему не привязана: нет X, сайта и Telegram'
      : kind === 'tweet' && !site ? `Монета на нарративе: ${bits.join(' · ')}`
        : `Проект: ${bits.join(' · ')}`;
    return { kind, label, handle, site, hasAny };
  }

  function links(mint, pairAddress) {
    return {
      photon: pairAddress ? `https://photon-sol.tinyastro.io/en/lp/${pairAddress}` : `https://photon-sol.tinyastro.io/en/discover?search=${mint}`,
      dexscreener: `https://dexscreener.com/solana/${pairAddress || mint}`,
      rugcheck: `https://rugcheck.xyz/tokens/${mint}`,
      solscan: `https://solscan.io/token/${mint}`,
    };
  }

  root.SolSniper = Object.freeze({
    DEFAULT_SETTINGS, WSOL, IGNORED_MINTS, KNOWN_POOL_OWNERS,
    isBase58Address, extractAddresses, isActiveTwitterLink,
    evaluateTokenPotential, classifyRisk, applySignalFilter, calcPosition,
    fmtUsd, fmtPrice, fmtPct, fmtSol, shortAddr, links, num,
    normalizeSocial, describeSocials,
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
