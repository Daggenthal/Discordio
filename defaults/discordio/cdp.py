"""
Minimal Chrome DevTools Protocol client for Steam's CEF.

Steam's UI exposes a DevTools endpoint on 127.0.0.1:8080. Each "target" (tab)
has a websocket; this client keeps one connection per target, matches
responses to requests by id with a background reader (so concurrent calls
work and a lost message can't wedge everything), and times out every call.
"""

import asyncio
import json

from aiohttp import ClientSession, ClientTimeout, WSMsgType  # type: ignore

DEBUGGER = "http://127.0.0.1:8080"


class CDPError(Exception):
    pass


class JSError(CDPError):
    """The evaluated JavaScript threw."""


async def list_targets(timeout=3):
    async with ClientSession(timeout=ClientTimeout(total=timeout)) as s:
        async with s.get(f"{DEBUGGER}/json") as r:
            if r.status != 200:
                raise CDPError(f"DevTools /json returned HTTP {r.status}")
            return await r.json()


async def find_target(predicate, timeout=3):
    for t in await list_targets(timeout):
        if predicate(t):
            return t
    return None


class Target:
    def __init__(self, info):
        self.info = info
        self.id = info.get("id")
        self.title = info.get("title", "")
        self.url = info.get("url", "")
        self.ws_url = info["webSocketDebuggerUrl"]
        self._session = None
        self._ws = None
        self._reader = None
        self._next_id = 0
        self._pending = {}
        self._event_handlers = []

    @property
    def connected(self):
        return self._ws is not None and not self._ws.closed

    async def connect(self, timeout=5):
        if self.connected:
            return self
        self._session = ClientSession()
        try:
            self._ws = await self._session.ws_connect(self.ws_url, timeout=timeout, max_msg_size=0)
        except Exception:
            await self._session.close()
            self._session = None
            raise
        self._reader = asyncio.get_running_loop().create_task(self._read())
        return self

    async def close(self):
        if self._reader:
            self._reader.cancel()
            self._reader = None
        if self._ws is not None:
            await self._ws.close()
            self._ws = None
        if self._session is not None:
            await self._session.close()
            self._session = None
        self._fail_pending(CDPError("connection closed"))

    def on_event(self, fn):
        self._event_handlers.append(fn)

    def _fail_pending(self, exc):
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(exc)
        self._pending.clear()

    async def _read(self):
        try:
            async for msg in self._ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                data = json.loads(msg.data)
                if "id" in data:
                    fut = self._pending.pop(data["id"], None)
                    if fut and not fut.done():
                        fut.set_result(data)
                elif "method" in data:
                    for fn in list(self._event_handlers):
                        try:
                            fn(data["method"], data.get("params", {}))
                        except Exception:
                            pass
        except asyncio.CancelledError:
            raise
        except Exception:
            pass
        finally:
            self._fail_pending(CDPError("connection lost"))
            # Steam went away (e.g. Game Mode restarting): release the HTTP
            # session too, or aiohttp warns about it being left open.
            if self._ws is not None and self._ws.closed:
                self._ws = None
                session, self._session = self._session, None
                if session is not None:
                    asyncio.get_running_loop().create_task(session.close())

    async def send(self, method, params=None, timeout=10):
        if not self.connected:
            await self.connect()
        self._next_id += 1
        mid = self._next_id
        fut = asyncio.get_running_loop().create_future()
        self._pending[mid] = fut
        await self._ws.send_json({"id": mid, "method": method, "params": params or {}})
        try:
            data = await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            self._pending.pop(mid, None)
            raise CDPError(f"{method} timed out after {timeout}s")
        if "error" in data:
            raise CDPError(f"{method}: {data['error'].get('message', data['error'])}")
        return data.get("result", {})

    async def evaluate(self, expression, timeout=10, await_promise=True):
        """Evaluate JS and return its value. Raises JSError if it threw."""
        res = await self.send("Runtime.evaluate", {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": await_promise,
        }, timeout=timeout)
        if "exceptionDetails" in res:
            d = res["exceptionDetails"]
            raise JSError((d.get("exception") or {}).get("description") or d.get("text") or "JavaScript error")
        return (res.get("result") or {}).get("value")
