#!/usr/bin/env python3
"""
SolSniper signal relay.

    Telegram (Telethon user session)  ─┐
                                       ├─►  ws://127.0.0.1:8080  ─►  browser extension
    HTTP POST /webhook (any bot/tool) ─┘

Usage:
    pip install -r requirements.txt
    export TG_API_ID=123456 TG_API_HASH=abcdef... TG_CHATS="@channel1,@channel2,-1001234567890"
    python server.py                 # Telegram + webhook
    python server.py --no-telegram   # webhook only
    python server.py --demo <MINT>   # emit a test signal every 30s

    The iPhone web app is served at http://127.0.0.1:8080/app/ ; expose it with
    `cloudflared tunnel --url http://localhost:8080` and set RELAY_TOKEN.

Webhook:
    curl -X POST http://127.0.0.1:8080/webhook -H 'content-type: application/json' \
         -H 'x-relay-token: $RELAY_TOKEN' -d '{"text": "new call: <MINT>", "channel": "my-bot"}'
"""
from __future__ import annotations

import argparse
import asyncio
import hmac
import json
import logging
import os
import re
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from aiohttp import ClientSession, ClientTimeout, WSMsgType, web

try:
    from telethon import TelegramClient, events
except ImportError:  # webhook-only mode still works
    TelegramClient = None
    events = None

log = logging.getLogger("solsniper")

B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
B58_INDEX = {c: i for i, c in enumerate(B58_ALPHABET)}
CA_RE = re.compile(r"(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])")
IGNORED = {
    "So11111111111111111111111111111111111111112",
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "Es9vMFrzaCERmJfrF8H2wpcqiS1Ycd9sUYyAdYafMoPj",
    "11111111111111111111111111111111",
}
DEDUPE_SECONDS = 600
APP_DIR = Path(__file__).resolve().parent
APP_FILES = {
    "index.html", "app.js", "app.css", "engine.js", "analyzer.js", "styles.css", "manifest.webmanifest",
    "icons/apple-touch-icon.png", "icons/icon192.png", "icons/icon512.png", "icons/icon48.png",
}
PROXY_HOSTS = {"api.dexscreener.com", "api.rugcheck.xyz", "mainnet.helius-rpc.com", "api.mainnet-beta.solana.com", "api.geckoterminal.com"}
EXTENSION_ORIGINS = ("chrome-extension://", "moz-extension://", "safari-web-extension://", "extension://")


def b58_decoded_len(s: str) -> int | None:
    n = 0
    for ch in s:
        v = B58_INDEX.get(ch)
        if v is None:
            return None
        n = n * 58 + v
    leading = len(s) - len(s.lstrip("1"))
    return leading + (n.bit_length() + 7) // 8


def extract_mints(text: str, limit: int = 3) -> list[str]:
    """Solana public keys are exactly 32 bytes; this drops tx signatures and random words."""
    out: list[str] = []
    for m in CA_RE.findall(text or ""):
        if m in IGNORED or m in out:
            continue
        if b58_decoded_len(m) == 32:
            out.append(m)
        if len(out) >= limit:
            break
    return out


class Hub:
    def __init__(self) -> None:
        self.clients: set[web.WebSocketResponse] = set()
        self.recent: dict[str, float] = {}

    def _fresh(self, mint: str) -> bool:
        now = time.time()
        self.recent = {k: t for k, t in self.recent.items() if now - t < DEDUPE_SECONDS}
        if mint in self.recent:
            return False
        self.recent[mint] = now
        return True

    async def publish(self, mints: list[str], text: str, channel: str, dedupe: bool = True) -> list[str]:
        sent = [m for m in mints if not dedupe or self._fresh(m)]
        if not sent:
            return []
        payload = json.dumps({
            "type": "signal",
            "id": uuid.uuid4().hex,
            "mints": sent,
            "text": text[:500],
            "channel": channel[:80],
            "ts": int(time.time() * 1000),
        })
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_str(payload)
            except Exception:  # noqa: BLE001 — drop broken sockets
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)
        log.info("signal %s from %s -> %d client(s)", ",".join(sent), channel, len(self.clients))
        return sent


def authorized(request: web.Request) -> bool:
    """With RELAY_TOKEN set, the token is required and sufficient (needed for phone / internet access).
    Without it, only local tools, the browser extension and same-origin pages (the /app/ web app) may connect."""
    token = request.app["token"]
    if token:
        given = request.headers.get("x-relay-token") or request.headers.get("x-webhook-token") or request.query.get("token") or ""
        return hmac.compare_digest(given.encode(), token.encode())
    origin = request.headers.get("Origin")
    if not origin:
        return True
    return origin.startswith(EXTENSION_ORIGINS) or origin == f"{request.scheme}://{request.host}"


def cors_headers(request: web.Request) -> dict:
    origin = request.headers.get("Origin")
    if not origin:
        return {}
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, accept, x-relay-token",
        "Access-Control-Max-Age": "600",
        "Vary": "Origin",
    }


async def root_handler(request: web.Request) -> web.StreamResponse:
    hub: Hub = request.app["hub"]
    if request.headers.get("Upgrade", "").lower() != "websocket":
        return web.json_response({"ok": True, "service": "solsniper-relay", "clients": len(hub.clients)})
    if not authorized(request):
        return web.Response(status=403, text="forbidden: bad token or origin")

    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    hub.clients.add(ws)
    log.info("client connected (%d total)", len(hub.clients))
    await ws.send_str(json.dumps({"type": "hello", "server": "solsniper-relay"}))
    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except ValueError:
                    continue
                if data.get("type") == "ping":
                    await ws.send_str(json.dumps({"type": "pong", "ts": data.get("ts")}))
            elif msg.type == WSMsgType.ERROR:
                log.warning("ws error: %s", ws.exception())
    finally:
        hub.clients.discard(ws)
        log.info("client disconnected (%d total)", len(hub.clients))
    return ws


async def webhook_handler(request: web.Request) -> web.Response:
    if not authorized(request):
        return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
    # JSON only: a browser page can't send application/json cross-origin without a CORS preflight we never grant.
    if request.content_type != "application/json":
        return web.json_response({"ok": False, "error": "content-type must be application/json"}, status=415)
    try:
        body = await request.json()
    except ValueError:
        return web.json_response({"ok": False, "error": "invalid json"}, status=400)

    text = str(body.get("text") or "")
    mints = body.get("mints") or ([body["mint"]] if body.get("mint") else [])
    mints = [m for m in mints if isinstance(m, str) and b58_decoded_len(m) == 32 and m not in IGNORED]
    mints = mints or extract_mints(text)
    if not mints:
        return web.json_response({"ok": False, "error": "no Solana address found"}, status=422)
    sent = await request.app["hub"].publish(mints[:3], text, str(body.get("channel") or "webhook"), dedupe=not body.get("force"))
    return web.json_response({"ok": True, "sent": sent, "deduped": [m for m in mints[:3] if m not in sent]})


async def proxy_handler(request: web.Request) -> web.Response:
    """CORS fallback for the web app: relays GET/POST to an allow-list of public Solana data APIs only."""
    headers = cors_headers(request)
    if request.method == "OPTIONS":
        return web.Response(status=204, headers=headers)
    if not authorized(request):
        return web.json_response({"ok": False, "error": "unauthorized"}, status=401, headers=headers)
    target = request.query.get("url", "")
    parts = urlsplit(target)
    if parts.scheme != "https" or parts.hostname not in PROXY_HOSTS:
        return web.json_response({"ok": False, "error": "host not allowed"}, status=400, headers=headers)
    body = await request.read() if request.method == "POST" else None
    if body is not None and len(body) > 64 * 1024:
        return web.json_response({"ok": False, "error": "body too large"}, status=413, headers=headers)
    try:
        async with request.app["http"].request(
            request.method, target, data=body,
            headers={"accept": "application/json", "content-type": request.headers.get("content-type", "application/json")},
        ) as up:
            data = await up.read()
            return web.Response(status=up.status, body=data, content_type="application/json", headers=headers)
    except Exception as e:  # noqa: BLE001
        return web.json_response({"ok": False, "error": f"upstream: {e.__class__.__name__}"}, status=502, headers=headers)


async def app_handler(request: web.Request) -> web.StreamResponse:
    """Serves the iPhone web app at /app/ (static, no secrets inside)."""
    name = request.match_info.get("path") or "index.html"
    if name not in APP_FILES:
        raise web.HTTPNotFound()
    return web.FileResponse(APP_DIR / name, headers={"Cache-Control": "no-cache"})


async def redirect_to_app(_request: web.Request) -> web.Response:
    raise web.HTTPFound("/app/")


async def http_client(app: web.Application):
    async with ClientSession(timeout=ClientTimeout(total=5), trust_env=True) as session:
        app["http"] = session
        yield


def parse_chats(raw: str) -> list:
    chats: list = []
    for c in (x.strip() for x in raw.split(",") if x.strip()):
        chats.append(int(c) if c.lstrip("-").isdigit() else c)
    return chats


async def run_telegram(hub: Hub) -> None:
    if TelegramClient is None:
        log.error("telethon is not installed — run: pip install telethon")
        return
    api_id = os.environ.get("TG_API_ID")
    api_hash = os.environ.get("TG_API_HASH")
    if not api_id or not api_hash:
        log.warning("TG_API_ID / TG_API_HASH not set — Telegram listener disabled (webhook still works)")
        return
    chats = parse_chats(os.environ.get("TG_CHATS", ""))
    client = TelegramClient(os.environ.get("TG_SESSION", "solsniper"), int(api_id), api_hash)

    @client.on(events.NewMessage(chats=chats or None))
    async def on_message(event):  # noqa: ANN001
        text = event.raw_text or ""
        mints = extract_mints(text)
        if not mints:
            return
        try:
            chat = await event.get_chat()
            channel = getattr(chat, "title", None) or getattr(chat, "username", None) or str(event.chat_id)
        except Exception:  # noqa: BLE001
            channel = str(event.chat_id)
        await hub.publish(mints, text, f"TG: {channel}")

    await client.start()  # first run asks for phone + code in the console, then reuses the .session file
    me = await client.get_me()
    log.info("Telegram connected as %s, watching %s", getattr(me, "username", None) or me.id, chats or "ALL chats")
    await client.run_until_disconnected()


async def run_demo(hub: Hub, mint: str) -> None:
    while True:
        await asyncio.sleep(30)
        await hub.publish([mint], f"DEMO call {mint}", "demo", dedupe=False)


async def main() -> None:
    ap = argparse.ArgumentParser(description="SolSniper Telegram/Webhook -> WebSocket relay")
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8080")))
    ap.add_argument("--no-telegram", action="store_true")
    ap.add_argument("--demo", metavar="MINT", help="emit a test signal for MINT every 30s")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    hub = Hub()
    app = web.Application()
    app["hub"] = hub
    app["token"] = os.environ.get("RELAY_TOKEN") or os.environ.get("WEBHOOK_TOKEN", "")
    app.cleanup_ctx.append(http_client)
    app.router.add_get("/", root_handler)
    app.router.add_post("/webhook", webhook_handler)
    app.router.add_route("*", "/proxy", proxy_handler)
    app.router.add_get("/app", redirect_to_app)
    app.router.add_get("/app/", app_handler)
    app.router.add_get("/app/{path:.+}", app_handler)

    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, args.host, args.port).start()
    log.info("relay on ws://%s:%d  (webhook: POST /webhook, web app: http://%s:%d/app/)", args.host, args.port, args.host, args.port)
    if not app["token"]:
        log.warning("RELAY_TOKEN not set: only local/extension clients allowed. Set it before exposing the server (phone, tunnel).")

    tasks = []
    if not args.no_telegram:
        tasks.append(asyncio.create_task(run_telegram(hub)))
    if args.demo:
        tasks.append(asyncio.create_task(run_demo(hub, args.demo)))
    try:
        await asyncio.Event().wait()
    finally:
        for t in tasks:
            t.cancel()
        await runner.cleanup()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
