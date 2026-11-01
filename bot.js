#!/usr/bin/env node
/**
 * SolSniper Telegram bot — 24/7 live scanner that posts only low-risk launches to Telegram.
 * Same engine as the web app (engine.js + analyzer.js + scanner.js). Node 22+, no npm dependencies.
 *
 *   TELEGRAM_BOT_TOKEN=123:abc HELIUS_API_KEY=xxxx node bot.js
 *
 * First run without TELEGRAM_CHAT_ID: send /start to your bot, it replies with the chat id to put in TELEGRAM_CHAT_ID.
 * To post into a channel: add the bot as a channel admin and use the channel id (-100…) or @channelname.
 */
'use strict';
require('./engine.js');
require('./analyzer.js');
require('./scanner.js');

const S = globalThis.SolSniper;
const env = process.env;
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

const settings = {
  ...S.DEFAULT_SETTINGS,
  heliusApiKey: env.HELIUS_API_KEY || '',
  rpcUrl: env.RPC_URL || '',
  maxTop10Pct: num(env.MAX_TOP10, 20),
  minVol5mUsd: num(env.MIN_VOL_5M, 30000),
  minScore: num(env.MIN_SCORE, 70),
  minLiqUsd: num(env.MIN_LIQ, 10000),
  watchMinutes: num(env.WATCH_MINUTES, 30),
  maxChecksPerMin: num(env.MAX_CHECKS_PER_MIN, 6),
  liveMigrationsOnly: env.MIGRATIONS_ONLY === '1',
};

const TOKEN = env.TELEGRAM_BOT_TOKEN || '';
let chatId = env.TELEGRAM_CHAT_ID || '';
const TG = `https://api.telegram.org/bot${TOKEN}`;

const logLine = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is required (create a bot with @BotFather).');
  process.exit(1);
}
if (!settings.heliusApiKey && !settings.rpcUrl) {
  logLine('WARNING: no HELIUS_API_KEY — public RPC often refuses, Top 10 will be n/a and most tokens get rejected.');
}
if (typeof WebSocket === 'undefined') {
  console.error(`Node ${process.version} has no global WebSocket. Use Node 22 or newer.`);
  process.exit(1);
}

// ------------------------------------------------------------------ telegram
async function tg(method, body) {
  const res = await fetch(`${TG}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(method === 'getUpdates' ? 40_000 : 10_000),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`${method}: ${j.description}`);
  return j.result;
}

const html = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const SOURCE = { pump: 'pump.fun launch', migration: 'migrated to AMM', profile: 'DexScreener profile' };

function alertText(item, r) {
  const t = r.token;
  const lp = t.isBondingCurve ? 'bonding curve' : S.fmtPct(t.lpBurnedPct, 0);
  const ageMin = Math.max(0, Math.round((Date.now() - (t.pairCreatedAt || item.firstSeen)) / 60_000));
  return [
    `<b>$${html(t.symbol)}</b> · Score <b>${r.evaluation.score}</b>/100 · ${html(r.badge.level)}`,
    html(t.name),
    `<code>${html(t.mint)}</code>`,
    '',
    `MC <b>${html(S.fmtUsd(t.marketCap))}</b> · Vol 5m <b>${html(S.fmtUsd(t.vol5m))}</b> · Liq ${html(S.fmtUsd(t.liquidityUsd))}`,
    `Top 10 ${html(S.fmtPct(t.top10Pct))} · Dev ${html(S.fmtPct(t.devPct))} · LP ${html(lp)}`,
    `Mint ${t.mintAuthority === false ? 'OFF' : 'ON?'} · Freeze ${t.freezeAuthority === false ? 'OFF' : 'ON?'} · ${t.socials.twitter ? 'X ✓' : 'X —'}`,
    `${html(SOURCE[item.source] || item.source)} · ~${ageMin} мин`,
    '',
    '<i>Не финсовет. Проверь сам перед входом.</i>',
  ].join('\n');
}

async function sendAlert(item, r) {
  if (!chatId) { logLine('ALERT (no TELEGRAM_CHAT_ID yet):', item.symbol, item.mint); return; }
  const l = r.token.links;
  await tg('sendMessage', {
    chat_id: chatId,
    text: alertText(item, r),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[
      { text: 'Photon', url: l.photon },
      { text: 'DEXScreener', url: l.dexscreener },
      { text: 'RugCheck', url: l.rugcheck },
    ]] },
  });
}

// Commands: /start → chat id, /status → live stats. Long polling, no webhook needed.
async function pollCommands() {
  let offset = 0;
  for (;;) {
    try {
      const updates = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'channel_post'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        const m = u.message || u.channel_post;
        if (!m || !m.text) continue;
        const cmd = m.text.trim().split(/\s|@/)[0].toLowerCase();
        if (cmd === '/start' || cmd === '/id') {
          await tg('sendMessage', {
            chat_id: m.chat.id,
            text: `SolSniper на связи.\nВаш chat id: <code>${m.chat.id}</code>\n${chatId ? 'Алерты уже настроены.' : 'Укажите его в TELEGRAM_CHAT_ID и перезапустите бота.'}`,
            parse_mode: 'HTML',
          });
          logLine(`chat id for ${m.chat.title || m.chat.username || m.chat.first_name}: ${m.chat.id}`);
        } else if (cmd === '/status') {
          const s = scanner.status();
          await tg('sendMessage', {
            chat_id: m.chat.id,
            text: `Поток: ${s.stream}\nУвидено: ${s.seen} · под наблюдением: ${s.watching}\nКандидатов: ${s.candidates} · полных проверок: ${s.checked}\nАлертов: ${s.alerts}`,
          });
        }
      }
    } catch (e) {
      logLine('telegram poll:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// ------------------------------------------------------------------ scanner
const analyzer = globalThis.SolSniperAnalyzer.createAnalyzer({ getSettings: () => settings, timeoutMs: 3000 });
const scanner = globalThis.SolSniperScanner.createScanner({
  analyzer,
  getSettings: () => settings,
  log: (...a) => logLine(...a),
  onEvent: (type, data) => {
    if (type === 'status') logLine('stream:', data.stream);
    if (type === 'alert') {
      logLine(`ALERT $${data.item.symbol} score ${data.result.evaluation.score} ${data.item.mint}`);
      sendAlert(data.item, data.result).catch((e) => logLine('send failed:', e.message));
    }
  },
});

(async () => {
  logLine(`SolSniper bot · vol5m ≥ $${settings.minVol5mUsd} · top10 ≤ ${settings.maxTop10Pct}% · score ≥ ${settings.minScore} · ${settings.maxChecksPerMin} checks/min`);
  pollCommands();
  scanner.start();
  if (chatId) {
    tg('sendMessage', { chat_id: chatId, text: 'SolSniper запущен. Слежу за новыми токенами, пришлю только те, что прошли фильтр.' })
      .catch((e) => logLine('cannot write to TELEGRAM_CHAT_ID:', e.message));
  } else {
    logLine('TELEGRAM_CHAT_ID not set: send /start to the bot to get it.');
  }
  setInterval(() => {
    const s = scanner.status();
    logLine(`seen ${s.seen} · watching ${s.watching} · candidates ${s.candidates} · checked ${s.checked} · alerts ${s.alerts}`);
  }, 5 * 60_000);
})();

process.on('SIGTERM', () => { scanner.stop(); process.exit(0); });
process.on('SIGINT', () => { scanner.stop(); process.exit(0); });
