# ◎ SolSniper HUD & Signal Filter

Chrome / Brave (десктоп) и Kiwi / Brave Mobile расширение (Manifest V3) для Solana-мемкоинов:

- автоматически находит CA токена на **DEXScreener, Pump.fun, Photon, BullX, GMGN, Axiom**;
- показывает плавающий HUD (Shadow DOM): RugCheck-бейдж, Mint/Freeze, LP burned, Top-10, Dev %, MC / Vol 5m / Liquidity;
- считает **Attention Score 0–100** и размер позиции с ценой Take Profit;
- принимает сигналы из Telegram (через `server.py`), прогоняет через жёсткий фильтр и шлёт push-уведомление только по прошедшим.

> ⚠️ Инструмент для анализа рисков, а не финансовый совет. Скоринг эвристический: SAFE ≠ «не скамят».

## 📱 iPhone (без Mac)

На iOS Chrome-расширения не ставятся, поэтому для iPhone есть **веб-приложение** (`index.html`) с тем же движком анализа: вставляешь CA или ссылку → RugCheck, Top-10, Dev, MC/Vol, Score, калькулятор позиции, лента сигналов.

**Запуск (один раз, ~3 минуты, всё с телефона):**
1. GitHub → репозиторий → **Settings → Pages** → Source: *Deploy from a branch* → ветка с проектом, папка `/ (root)` → Save.
2. Через 1–2 минуты приложение будет по адресу `https://<username>.github.io/memecoin-extension/`.
3. Открыть ссылку в **Safari** → «Поделиться» → **«На экран Домой»**. Запускается без адресной строки, как обычное приложение.
4. ⚙️ Настройки → вставить **Helius API key**.

**Как пользоваться:** скопировать CA или ссылку (DEXScreener, pump.fun, Photon, GMGN, Solscan) → в приложении нажать **📋 Вставить**. Подойдёт и ссылка вида `…/memecoin-extension/?ca=<CA>`; с ней можно сделать «Быструю команду» iOS, которая открывает приложение прямо из меню «Поделиться».

**Сигналы из Telegram на iPhone** требуют запущенного `server.py` (на ПК/VPS):
```bash
export RELAY_TOKEN=$(python3 -c "import secrets;print(secrets.token_urlsafe(24))")
python server.py
cloudflared tunnel --url http://localhost:8080   # бесплатно, даёт https://xxxx.trycloudflare.com
```
В приложении: Настройки → *URL сервера* = адрес туннеля, *Токен* = `RELAY_TOKEN`. Приложение раздаётся и самим сервером: `https://xxxx.trycloudflare.com/app/`.

Ограничения iOS: сигналы приходят, **только пока приложение открыто** (iOS замораживает фоновые вкладки; при возвращении приложение переподключается само). Автоматического HUD поверх DEXScreener нет — CA вставляется вручную.

Если какой-то API не отдаёт CORS-заголовки браузеру, приложение само переключится на `/proxy` сервера. Прокси пропускает только DexScreener, RugCheck, Helius и Solana RPC и работает только с токеном.

## 📡 Live-сканер и Telegram-бот

Сканер ловит **каждый новый токен** и присылает алерт только по тем, что прошли фильтр.

1. **Поиск:** PumpPortal WebSocket (все запуски pump.fun и миграции на Raydium/PumpSwap) и новые профили DexScreener.
2. **Предфильтр:** пакетный запрос DexScreener, 30 токенов за раз: Vol 5m ≥ порога, ликвидность ≥ `minLiqUsd`.
3. **Полная проверка:** RugCheck + Helius, не чаще `maxChecksPerMin` в минуту, чтобы не сжечь бесплатные лимиты.
4. **Алерт:** фильтр сигналов пройден (Score, Freeze OFF, Top 10, Vol 5m) и бейдж не DANGER.

**В приложении:** вкладка **Live** → «Новые токены» → включить. Во вкладке «Кошельки» можно добавить адреса KOL/трейдеров: видны их сделки и кластеры (2+ кошелька в одном токене).

**Уведомления на iPhone:** только у приложения с экрана «Домой» (iOS 16.4+): Настройки → «Включить уведомления». Приходят, пока приложение открыто или недавно свёрнуто; при заблокированном телефоне — через Telegram-бота.

 Работает, пока приложение открыто; «Не гасить экран» держит iPhone активным (удобно на зарядке).

**Telegram-бот (`bot.js`)** — те же правила, работает 24/7 и пишет в личку или в канал:
1. В Telegram открыть @BotFather → `/newbot` → скопировать токен.
2. Развернуть репозиторий на любом хостинге с Docker (Railway, Render Background Worker, VPS). Есть `Dockerfile`, Node 22, зависимостей нет.
3. Переменные окружения: `TELEGRAM_BOT_TOKEN`, `HELIUS_API_KEY`, затем `TELEGRAM_CHAT_ID`. Чтобы узнать chat id, напиши боту `/start`, он ответит. Для канала: добавь бота админом и укажи `@channel` или `-100…`.
4. Необязательные: `MIN_VOL_5M` (30000), `MAX_TOP10` (20), `MIN_SCORE` (70), `MIN_LIQ` (10000), `MAX_CHECKS_PER_MIN` (6), `WATCH_MINUTES` (30), `MIGRATIONS_ONLY=1`.

**Кошельки трейдеров:** `WALLETS="Alpha:АДРЕС,Beta:АДРЕС"` — бот пишет об их покупках на pump.fun/PumpSwap и отдельно, когда 2+ кошелька зашли в один токен за 30 минут. `WALLET_SELLS=1` — присылать и продажи.

Команды бота: `/start` (chat id), `/status` (статистика). Локально: `TELEGRAM_BOT_TOKEN=… HELIUS_API_KEY=… node bot.js`.

> Алерт — это прошедший фильтр токен, а не гарантия. Если публикуешь алерты в канал, подписывай их как «не финсовет».

## Структура

| Файл | Что делает |
|---|---|
| `manifest.json` | MV3: `storage`, `notifications`, `activeTab`, `scripting`, `alarms` + host permissions для DexScreener / RugCheck / Helius / Solana RPC |
| `background.js` | Service worker: API-агрегатор (таймаут 1.5 с на запрос), кэш 12 с, дедуп запросов, WebSocket-клиент с автопереподключением, фильтр сигналов, уведомления |
| `scanner.js` | Live-сканер: поток новых токенов → предфильтр → полная проверка → алерт (общий для приложения и бота) |
| `bot.js` / `Dockerfile` | Telegram-бот с алертами 24/7 |
| `analyzer.js` | Общий конвейер данных (расширение + веб-приложение): DexScreener + RugCheck + RPC → снимок токена |
| `index.html` / `app.js` / `app.css` / `manifest.webmanifest` | Веб-приложение для iPhone (PWA) |
| `engine.js` | Общая логика (SW + content + popup + web app): `evaluateTokenPotential`, `classifyRisk`, `applySignalFilter`, `calcPosition`, форматтеры |
| `content.js` | Определение CA из URL / DOM, отслеживание SPA-навигации, автообновление каждые 15 с |
| `ui-overlay.js` | Floating HUD в закрытом Shadow DOM: drag на ПК, bottom-sheet на мобильном, сворачивание в «пилюлю» |
| `styles.css` | Тёмные неоновые стили виджета (подгружаются в Shadow DOM через constructable stylesheet — CSP сайта не мешает) |
| `popup.html` / `popup.js` | Скан вкладки / ручной CA, фильтры, подключения, лента сигналов |
| `server.py` | Telethon + aiohttp релей: Telegram и HTTP webhook → `ws://127.0.0.1:8080`, раздача веб-приложения (`/app/`), CORS-прокси (`/proxy`) |

## Установка расширения

**Chrome / Brave (ПК):** `chrome://extensions` → включить «Режим разработчика» → «Загрузить распакованное» → выбрать папку репозитория.

**Kiwi Browser (Android):** заархивировать папку в `.zip` → `kiwi://extensions` → Developer mode → `+ (from .zip/.crx/.user.js)`.
Popup открывается как отдельная страница — интерфейс под это адаптирован. Push-уведомления на Android могут не поддерживаться; лента сигналов в popup работает всегда.

> Brave Mobile пока не поддерживает установку сторонних расширений; для мобильного использования — Kiwi (или любой Chromium-браузер с поддержкой расширений).

### Рекомендуемая настройка
Popup → **Фильтры** → вставить **Helius API key** (бесплатный на helius.dev). Без ключа используется публичный `api.mainnet-beta.solana.com`, который часто режет `getTokenLargestAccounts` по rate-limit — тогда Top-10 будет `n/a`. Свой RPC (QuickNode, Triton и т.п.) — поле *Custom RPC URL*; если хост не из списка host_permissions, у RPC должен быть включён CORS.

## Telegram-релей (`server.py`)

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

export TG_API_ID=123456              # https://my.telegram.org → API development tools
export TG_API_HASH=0123456789abcdef
export TG_CHATS="@alpha_calls,-1001234567890"   # пусто = все чаты аккаунта
export RELAY_TOKEN=secret             # обязателен, если сервер доступен из интернета (телефон, туннель)
python server.py
```
Первый запуск попросит телефон и код из Telegram, дальше используется файл `solsniper.session` (в `.gitignore` — не публикуйте его, это доступ к аккаунту).

Режимы: `--no-telegram` (только webhook), `--demo <MINT>` (тестовый сигнал каждые 30 с), `--host/--port`.

**Webhook** для любых ботов/скриптов:
```bash
curl -X POST http://127.0.0.1:8080/webhook \
  -H 'content-type: application/json' -H 'x-relay-token: secret' \
  -d '{"text":"new call 7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr","channel":"my-bot"}'
```
Из текста извлекаются только валидные 32-байтные Solana-адреса (подписи транзакций, SOL/USDC/USDT отбрасываются), повторы одного CA гасятся на 10 минут.

Доступ: если задан `RELAY_TOKEN`, он обязателен для WebSocket (`?token=`), `/webhook` и `/proxy` (заголовок `x-relay-token`). Расширению в этом случае укажите `ws://localhost:8080/?token=<RELAY_TOKEN>`. Без токена сервер пускает только локальные инструменты, расширение и собственную страницу `/app/` — обычные сайты читать сигналы не могут.

## Как считается

### Attention Score (0–100)
| Условие | Баллы |
|---|---|
| LP burned ≥ 99% **и** Mint authority OFF | +40 |
| Top-10 холдеров < 15% | +20 |
| Volume 5m / Market Cap > 0.2 | +20 |
| Есть ссылка на X/Twitter (профиль/комьюнити, не поиск) | +20 |

Score < `Min Score` (по умолчанию 70) → **HIGH RUG RISK**. Неизвестные данные баллов не дают.
Токены на bonding curve pump.fun считаются как «LP locked» — ликвидность там в программе, вытащить её дев не может (в HUD: `BC 🔒`).

### Жёсткий фильтр сигналов
Сигнал одобряется, только если: score ≥ Min Score, Freeze OFF, Top-10 ≤ `Max Top 10` (20%), Vol 5m ≥ `Min Volume 5m` ($30k). Иначе он попадает в ленту как отклонённый с причинами и без уведомления.

### Бейдж
- **DANGER** — Mint или Freeze ON, LP < 50%, Top-10 > 50%, Dev > 20% или «danger»-риск от RugCheck.
- **WARNING** — score ниже порога, Top-10 выше лимита, warn-риски RugCheck, неизвестные authorities.
- **SAFE** — ничего из перечисленного.

### Top-10 и Dev
Top-10 считается on-chain (`getTokenLargestAccounts` + владельцы аккаунтов) **без** пулов: исключаются все pair-адреса DexScreener, AMM-аккаунты из RugCheck, authority Raydium v4/CPMM и incinerator. Dev % берётся из RugCheck report (`creator`). Fallback для Top-10 — `topHolders` из RugCheck.

### Калькулятор позиции
`позиция = депозит × риск%`; TP: продать 50% на 2x → цена `entry × 2`, MC `MC × 2`; вывод на TP = тело позиции. Цена SOL берётся из SOL-пары DexScreener (`priceUsd / priceNative`).

## Ограничения
- Таймаут 1.5 с на каждый запрос. Полный report RugCheck тяжёлый и иногда не успевает — тогда Dev % = `n/a`, а данные подтягиваются при следующем автообновлении (15 с). Для pair-URL (DexScreener/Photon) сначала резолвится mint, это ещё один запрос.
- «Активность» X-аккаунта не проверяется (нужен платный X API) — учитывается наличие валидной ссылки.
- MV3 service worker может быть выгружен; WebSocket держится пингом каждые 20 с, плюс watchdog через `chrome.alarms` переподключает каждые 30 с.
