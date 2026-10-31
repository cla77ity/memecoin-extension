# ◎ SolSniper HUD & Signal Filter

Chrome / Brave (десктоп) и Kiwi / Brave Mobile расширение (Manifest V3) для Solana-мемкоинов:

- автоматически находит CA токена на **DEXScreener, Pump.fun, Photon, BullX, GMGN, Axiom**;
- показывает плавающий HUD (Shadow DOM): RugCheck-бейдж, Mint/Freeze, LP burned, Top-10, Dev %, MC / Vol 5m / Liquidity;
- считает **Attention Score 0–100** и размер позиции с ценой Take Profit;
- принимает сигналы из Telegram (через `server.py`), прогоняет через жёсткий фильтр и шлёт push-уведомление только по прошедшим.

> ⚠️ Инструмент для анализа рисков, а не финансовый совет. Скоринг эвристический: SAFE ≠ «не скамят».

## Структура

| Файл | Что делает |
|---|---|
| `manifest.json` | MV3: `storage`, `notifications`, `activeTab`, `scripting`, `alarms` + host permissions для DexScreener / RugCheck / Helius / Solana RPC |
| `background.js` | Service worker: API-агрегатор (таймаут 1.5 с на запрос), кэш 12 с, дедуп запросов, WebSocket-клиент с автопереподключением, фильтр сигналов, уведомления |
| `engine.js` | Общая логика (SW + content + popup): `evaluateTokenPotential`, `classifyRisk`, `applySignalFilter`, `calcPosition`, форматтеры |
| `content.js` | Определение CA из URL / DOM, отслеживание SPA-навигации, автообновление каждые 15 с |
| `ui-overlay.js` | Floating HUD в закрытом Shadow DOM: drag на ПК, bottom-sheet на мобильном, сворачивание в «пилюлю» |
| `styles.css` | Тёмные неоновые стили виджета (подгружаются в Shadow DOM через constructable stylesheet — CSP сайта не мешает) |
| `popup.html` / `popup.js` | Скан вкладки / ручной CA, фильтры, подключения, лента сигналов |
| `server.py` | Telethon + aiohttp релей: Telegram и HTTP webhook → `ws://127.0.0.1:8080` |

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
export WEBHOOK_TOKEN=secret           # опционально
python server.py
```
Первый запуск попросит телефон и код из Telegram, дальше используется файл `solsniper.session` (в `.gitignore` — не публикуйте его, это доступ к аккаунту).

Режимы: `--no-telegram` (только webhook), `--demo <MINT>` (тестовый сигнал каждые 30 с), `--host/--port`.

**Webhook** для любых ботов/скриптов:
```bash
curl -X POST http://127.0.0.1:8080/webhook \
  -H 'content-type: application/json' -H 'x-webhook-token: secret' \
  -d '{"text":"new call 7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr","channel":"my-bot"}'
```
Из текста извлекаются только валидные 32-байтные Solana-адреса (подписи транзакций, SOL/USDC/USDT отбрасываются), повторы одного CA гасятся на 10 минут. WebSocket принимает подключения только без `Origin` или с `chrome-extension://` — обычные сайты читать сигналы не могут.

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
