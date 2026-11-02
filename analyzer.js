/**
 * SolSniper analyzer — data pipeline shared by the extension service worker and the iPhone web app.
 * Aggregates DexScreener + RugCheck + Solana RPC (Helius) into one token snapshot and applies engine.js scoring.
 * Requires engine.js. Exposes `globalThis.SolSniperAnalyzer.createAnalyzer(opts)`.
 */
(function (root) {
  'use strict';
  const S = root.SolSniper;
  const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
  const SYSTEM_PROGRAM = '11111111111111111111111111111111';

  /**
   * @param {object} o
   * @param {() => object} o.getSettings  current settings (merged with defaults)
   * @param {(url:string, init:object) => Promise<Response>} [o.fetchImpl]  custom transport (e.g. proxy fallback)
   * @param {number} [o.timeoutMs]
   * @param {number} [o.cacheTtlMs]
   */
  function createAnalyzer({ getSettings, fetchImpl, timeoutMs = 1500, cacheTtlMs = 12_000 }) {
    const doFetch = fetchImpl || ((u, i) => fetch(u, i));
    const cache = new Map();
    const inflight = new Map();

    async function fetchJson(url, init = {}, timeout = timeoutMs) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      const host = (() => { try { return new URL(url).hostname; } catch (_) { return url; } })();
      try {
        const res = await doFetch(url, { ...init, signal: ctrl.signal, headers: { accept: 'application/json', ...(init.headers || {}) } });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${host}`);
        return await res.json();
      } catch (e) {
        if (e.name === 'AbortError') throw new Error(`Timeout ${timeout}ms ${host}`);
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }

    function rpcEndpoint() {
      const s = getSettings();
      if (s.rpcUrl) return s.rpcUrl.trim();
      if (s.heliusApiKey) {
        // Accept a bare key or a full pasted Helius URL (…helius-rpc.com/?api-key=XXXX).
        const raw = s.heliusApiKey.trim();
        const key = (raw.match(/api-key=([A-Za-z0-9-]+)/) || [])[1] || raw;
        return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
      }
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

    // ---------------------------------------------------------- sources
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
        // Who owns the owner? Real wallets are System Program accounts (or empty). Owners run by another program are
        // pools, bonding curves, vault authorities or lockers — liquidity, not holders. Works for any AMM.
        if (!out.ownersError) {
          const owners = [...new Set(out.holders.map((h) => h.owner).filter(Boolean))];
          try {
            const [prog] = await rpcBatch([
              { method: 'getMultipleAccounts', params: [owners, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }] },
            ]);
            const vals = (prog && prog.result && prog.result.value) || [];
            const programOwned = new Set(owners.filter((o, i) => vals[i] && vals[i].owner && vals[i].owner !== SYSTEM_PROGRAM));
            for (const h of out.holders) if (programOwned.has(h.owner)) h.programOwned = true;
          } catch (_) { /* fall back to the known-pool list */ }
        }
      }
      return out;
    }

    async function heliusAsset(mint) {
      const s = getSettings();
      if (!s.heliusApiKey || s.rpcUrl) return null;
      const [r] = await rpcBatch([{ method: 'getAsset', params: { id: mint } }]);
      const asset = r && r.result ? r.result : null;
      // Off-chain metadata JSON (pump.fun stores description / twitter / telegram / website there).
      const uri = asset && asset.content && asset.content.json_uri;
      if (asset && typeof uri === 'string' && /^https:\/\//.test(uri)) {
        asset._offchain = await fetchJson(uri).catch(() => null);
      }
      return asset;
    }

    // ---------------------------------------------------------- pipeline
    async function resolveTarget(address, kind) {
      if (kind === 'pair') {
        const pair = await dexByPair(address).catch(() => null);
        if (pair && pair.baseToken) return { mint: pair.baseToken.address, viewedPair: pair };
        return { mint: address, viewedPair: null };
      }
      if (kind === 'mint') return { mint: address, viewedPair: null };
      const pairs = await dexByToken(address).catch(() => []);
      if (pairs.some((p) => p.baseToken && p.baseToken.address === address)) return { mint: address, viewedPair: null, pairs };
      const pair = await dexByPair(address).catch(() => null);
      if (pair && pair.baseToken) return { mint: pair.baseToken.address, viewedPair: pair };
      return { mint: address, viewedPair: null, pairs };
    }

    async function analyzeToken(address, kind = 'unknown', force = false) {
      if (!S.isBase58Address(address)) throw new Error('Invalid address');
      const key = `${kind}:${address}`;
      if (!force) {
        const hit = cache.get(key);
        if (hit && Date.now() - hit.at < cacheTtlMs) return hit.data;
        if (inflight.has(key)) return inflight.get(key);
      }
      const p = (async () => {
        const target = await resolveTarget(address, kind);
        const { mint } = target;
        const settled = await Promise.allSettled([
          target.pairs ? Promise.resolve(target.pairs) : dexByToken(mint),
          rugSummary(mint),
          rugReport(mint),
          onchain(mint),
          heliusAsset(mint),
        ]);
        const assetOk = settled[4].status === 'fulfilled' && settled[4].value;
        const report = settled[2].status === 'fulfilled' ? settled[2].value : null;
        const uri = report && report.tokenMeta && report.tokenMeta.uri;
        if (!assetOk && typeof uri === 'string' && /^https:\/\//.test(uri)) {
          const off = await fetchJson(uri).catch(() => null);
          if (off) settled[4] = { status: 'fulfilled', value: { _offchain: off } };
        }
        const result = withVerdict(mergeData(mint, target.viewedPair, ...settled));
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

    function withVerdict(data) {
      const f = S.applySignalFilter(data, getSettings());
      return { token: data, evaluation: f.evaluation, badge: f.badge, filter: { approved: f.approved, reasons: f.reasons } };
    }

    return {
      analyzeToken,
      rpcEndpoint,
      clearCache: () => cache.clear(),
      rescore: withVerdict,
    };
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

    const own = pairs.filter((p) => p.baseToken && p.baseToken.address === mint)
      .sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
    const pair = (viewedPair && viewedPair.baseToken && viewedPair.baseToken.address === mint ? viewedPair : null) || own[0] || null;
    const info = (pair && pair.info) || {};
    const socials = {};
    for (const s of info.socials || []) {
      const type = (s.type || s.platform || '').toLowerCase();
      if ((type === 'twitter' || type === 'x') && !socials.twitter) socials.twitter = s.url || s.handle;
      if (type === 'telegram' && !socials.telegram) socials.telegram = s.url || s.handle;
    }
    if (info.websites && info.websites[0]) socials.website = info.websites[0].url;
    // fill gaps from on-chain metadata (pump.fun JSON / DAS)
    const off = (asset && asset._offchain) || {};
    const ext = off.extensions || {};
    const links = (asset && asset.content && asset.content.links) || {};
    if (!socials.twitter) socials.twitter = off.twitter || ext.twitter || null;
    if (!socials.telegram) socials.telegram = off.telegram || ext.telegram || null;
    if (!socials.website) socials.website = off.website || ext.website || links.external_url || null;
    for (const k of ['twitter', 'telegram', 'website']) {
      socials[k] = S.normalizeSocial(k, socials[k]) || undefined;
      if (!socials[k]) delete socials[k];
    }

    const priceUsd = S.num(pair && pair.priceUsd);
    const priceNative = S.num(pair && pair.priceNative);
    const quoteIsSol = pair && pair.quoteToken && pair.quoteToken.address === S.WSOL;
    const dexId = pair ? pair.dexId : null;
    const isPumpMint = mint.endsWith('pump');
    const isBondingCurve = dexId === 'pumpfun' || (!pair && isPumpMint && !(report && report.markets && report.markets.length));

    // authorities: on-chain first, RugCheck report / Helius DAS fallback
    let mintAuthority = chain ? chain.mintAuthority : null;
    let freezeAuthority = chain ? chain.freezeAuthority : null;
    if (mintAuthority === null && report && 'mintAuthority' in report) mintAuthority = report.mintAuthority != null;
    if (freezeAuthority === null && report && 'freezeAuthority' in report) freezeAuthority = report.freezeAuthority != null;
    if (mintAuthority === null && asset && asset.token_info) mintAuthority = !!asset.token_info.mint_authority;
    if (freezeAuthority === null && asset && asset.token_info) freezeAuthority = !!asset.token_info.freeze_authority;

    // LP burned / locked %
    let lpBurnedPct = S.num(summary && summary.lpLockedPct);
    if (lpBurnedPct === null && report && Array.isArray(report.markets)) {
      const vals = report.markets.map((m) => S.num(m.lp && m.lp.lpLockedPct)).filter((v) => v !== null);
      if (vals.length) lpBurnedPct = Math.max(...vals);
    }

    // holder concentration, excluding pools / AMM authorities / burn
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
      const real = chain.holders.filter((h) => !h.programOwned && !exclude.has(h.address) && !exclude.has(h.owner));
      top10Pct = (real.slice(0, 10).reduce((s, h) => s + h.amountRaw, 0) / supplyRaw) * 100;
    } else if (report && Array.isArray(report.topHolders) && report.topHolders.length) {
      const real = report.topHolders.filter((h) => !exclude.has(h.address) && !exclude.has(h.owner));
      top10Pct = real.slice(0, 10).reduce((s, h) => s + (S.num(h.pct) || 0), 0);
    }

    // owners of the largest non-pool accounts (lets the UI flag tracked wallets among holders)
    const holderOwners = [];
    const addOwner = (o) => { if (o && !exclude.has(o) && !holderOwners.includes(o)) holderOwners.push(o); };
    if (chain) for (const h of chain.holders) if (!h.programOwned) addOwner(h.owner);
    if (report && Array.isArray(report.topHolders)) for (const h of report.topHolders) addOwner(h.owner);

    // dev wallet
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
    const rawDesc = (asset && asset._offchain && asset._offchain.description) || meta.description
      || (report && report.fileMeta && report.fileMeta.description) || '';
    const description = String(rawDesc).replace(/\s+/g, ' ').trim().slice(0, 600);
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
      change1h: S.num(pair && pair.priceChange && pair.priceChange.h1),
      change24h: S.num(pair && pair.priceChange && pair.priceChange.h24),
      txns5m: pair && pair.txns && pair.txns.m5 ? pair.txns.m5 : null,
      pairCreatedAt: pair ? pair.pairCreatedAt || null : null,
      socials,
      mintAuthority,
      freezeAuthority,
      lpBurnedPct,
      top10Pct,
      devPct,
      holderOwners: holderOwners.slice(0, 40),
      description,
      project: S.describeSocials(socials),
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

  root.SolSniperAnalyzer = Object.freeze({ createAnalyzer, mergeData });
})(typeof globalThis !== 'undefined' ? globalThis : self);
