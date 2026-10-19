"""
Backend side of the Discordio bridge.

The Discord page connects to ws://127.0.0.1:<port>/bridge. Messages:

  page -> backend   {"t": "hello", "version": ...}
                    {"t": "event", "name": ..., "data": ...}
                    {"t": "res", "id": n, "ok": true, "result": ...}
                    {"t": "res", "id": n, "ok": false, "error": "..."}
  backend -> page   {"t": "req", "id": n, "method": ..., "params": {...}}
                    {"t": "push", "name": ..., "data": ...}

Every request has a timeout, failures carry the page's error message, and
counters / latency feed the diagnostics.
"""

import asyncio
import time

from aiohttp import WSMsgType  # type: ignore
from aiohttp.web import WebSocketResponse  # type: ignore

from . import diag


class BridgeError(Exception):
    pass


class Bridge:
    def __init__(self, logger):
        self.log = logger
        self.ws = None
        self.version = None
        self.connected_at = 0
        self.last_message = 0
        self._next = 0
        self._pending = {}
        self._handlers = {}
        self.stats = {"requests": 0, "failed": 0, "timeouts": 0, "latency_ms": 0.0, "connects": 0}
        self.recent_failures = []

    @property
    def connected(self):
        return self.ws is not None and not self.ws.closed

    def on(self, name, fn):
        """Handle an event from the page: fn(data), may be async."""
        self._handlers.setdefault(name, []).append(fn)

    async def handle(self, request):
        ws = WebSocketResponse(max_msg_size=0, heartbeat=20)
        await ws.prepare(request)
        if self.connected:
            self.log.info("Bridge: a new Discord page replaced the old connection")
            await self.ws.close()
        self.ws = ws
        self.connected_at = time.time()
        self.stats["connects"] += 1
        diag.set("bridge", diag.PENDING, "connected, waiting for Discord to load")
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                self.last_message = time.time()
                try:
                    await self._dispatch(msg.json())
                except Exception as e:
                    self.log.warning(f"Bridge message error: {e}")
        finally:
            if self.ws is ws:
                self.ws = None
                for fut in self._pending.values():
                    if not fut.done():
                        fut.set_exception(BridgeError("Discord page disconnected"))
                self._pending.clear()
                diag.set("bridge", diag.WARN, "Discord page disconnected (it reconnects by itself)")
                await self._emit("disconnected", None)
        return ws

    async def _dispatch(self, data):
        t = data.get("t")
        if t == "res":
            fut = self._pending.pop(data.get("id"), None)
            if fut and not fut.done():
                if data.get("ok"):
                    fut.set_result(data.get("result"))
                else:
                    fut.set_exception(BridgeError(data.get("error") or "request failed in Discord"))
        elif t == "event":
            await self._emit(data.get("name"), data.get("data"))
        elif t == "hello":
            self.version = data.get("version")
            diag.set("bridge", diag.OK, f"connected (page {self.version})")
            await self._emit("hello", data)

    async def _emit(self, name, payload):
        for fn in self._handlers.get(name, []):
            try:
                r = fn(payload)
                if asyncio.iscoroutine(r):
                    await r
            except Exception as e:
                self.log.warning(f"Bridge handler for {name}: {e}")

    async def request(self, method, params=None, timeout=10):
        if not self.connected:
            raise BridgeError("Discord isn't connected yet (still loading, or the view needs a restart)")
        self._next += 1
        rid = self._next
        fut = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        started = time.monotonic()
        self.stats["requests"] += 1
        await self.ws.send_json({"t": "req", "id": rid, "method": method, "params": params or {}})
        try:
            result = await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            self._pending.pop(rid, None)
            self.stats["timeouts"] += 1
            self._failure(method, f"no answer within {timeout}s")
            raise BridgeError(f"Discord didn't answer {method} within {timeout}s")
        except BridgeError as e:
            self.stats["failed"] += 1
            self._failure(method, str(e))
            raise
        ms = (time.monotonic() - started) * 1000
        self.stats["latency_ms"] = round(self.stats["latency_ms"] * 0.8 + ms * 0.2, 1)
        return result

    def _failure(self, method, message):
        self.recent_failures.append({"time": time.time(), "method": method, "error": message})
        del self.recent_failures[:-15]
        diag.error("bridge", f"{method}: {message}")

    async def push(self, name, data=None):
        if self.connected:
            await self.ws.send_json({"t": "push", "name": name, "data": data})

    def info(self):
        return {
            "connected": self.connected,
            "version": self.version,
            "connected_for_s": round(time.time() - self.connected_at) if self.connected else 0,
            "last_message_age_s": round(time.time() - self.last_message, 1) if self.last_message else None,
            **self.stats,
            "recent_failures": self.recent_failures[-5:],
        }
