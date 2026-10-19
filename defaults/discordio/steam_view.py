"""
The Discord browser view inside Steam's Game Mode UI.

Steam's UI can host extra browser views. This module creates one for
discord.com (hidden until opened from the QAM), injects Discordio's page
scripts before Discord's own code runs, and recreates the view if it dies.
It reports each step to diagnostics and forwards page errors to the log.
"""

import asyncio
import json
import time
from pathlib import Path

from . import cdp, diag, vencord

PLACEHOLDER = "data:text/plain,discordio"
PAGE_SCRIPTS = ["config", "bridge.js", "media.js", "mic.js", "capture.js", "nav.js"]

CREATE_JS = r"""
(() => {
    const Router = window.DISCORDIO_ROUTER || (window.DFL && window.DFL.Router);
    if (!Router) throw new Error("Steam router not available yet (Discordio's QAM part hasn't loaded)");
    const main = Router.WindowStore && Router.WindowStore.GamepadUIMainWindowInstance;
    if (!main) throw new Error("Steam's Game Mode window wasn't found (not in Game Mode?)");
    if (typeof main.CreateBrowserView !== "function")
        throw new Error("This Steam build has no CreateBrowserView");

    const old = window.DISCORDIO_VIEW;
    if (old) {
        try { old.m_browserView.SetVisible(false); } catch (e) {}
        try { old.Destroy(); } catch (e) {}
        window.DISCORDIO_VIEW = undefined;
    }
    const view = main.CreateBrowserView("discordio");
    if (!view || !view.m_browserView) throw new Error("CreateBrowserView returned nothing");
    window.DISCORDIO_VIEW = view;
    window.DISCORD_TAB = view; // older frontend name

    const bw = main.BrowserWindow;
    view.WIDTH = (bw && bw.innerWidth) || 1280;
    view.HEIGHT = (bw && bw.innerHeight) || 800;
    view.m_browserView.SetBounds(0, 0, view.WIDTH, view.HEIGHT);
    view.m_browserView.LoadURL(PLACEHOLDER);
    // Hidden and unfocused until the user opens it.
    try { view.m_browserView.SetVisible(false); } catch (e) {}
    try { view.m_browserView.SetFocus(false); } catch (e) {}

    // Shrink while the on-screen keyboard is up, so the text box stays visible.
    let kb = "ok";
    try {
        main.m_VirtualKeyboardManager.IsShowingVirtualKeyboard.m_callbacks.m_vecCallbacks.push((shown) => {
            const v = window.DISCORDIO_VIEW;
            if (!v) return;
            const h = shown ? Math.round(v.HEIGHT * 0.6) : v.HEIGHT;
            try { v.m_browserView.SetBounds(0, 0, v.WIDTH, h); } catch (e) {}
        });
    } catch (e) { kb = "keyboard resize unavailable"; }
    return kb;
})()
""".replace("PLACEHOLDER", json.dumps(PLACEHOLDER))

SHOW_KEYBOARD_JS = "window.DISCORDIO_VIEW && window.DISCORDIO_VIEW.m_virtualKeyboardHost.m_showKeyboard()"
DESTROY_JS = """
(() => {
    const v = window.DISCORDIO_VIEW;
    if (!v) return "none";
    try { v.m_browserView.SetVisible(false); } catch (e) {}
    try { v.Destroy(); } catch (e) {}
    window.DISCORDIO_VIEW = undefined;
    window.DISCORD_TAB = undefined;
    return "destroyed";
})()
"""


class DiscordView:
    def __init__(self, plugin_dir, cache_dir, config, logger):
        self.dir = Path(plugin_dir) / "page"
        self.cache_dir = cache_dir
        self.config = config  # dict passed to the page as window.DISCORDIO_CONFIG
        self.log = logger
        self.shared = None
        self.target = None
        self.created_at = 0
        self.restart_requested = asyncio.Event()

    # -- Steam's shared UI context (where Decky plugins run) --

    async def shared_context(self):
        if self.shared and self.shared.connected:
            return self.shared
        info = await cdp.find_target(lambda t: t.get("title") == "SharedJSContext")
        if not info:
            raise cdp.CDPError("Steam's SharedJSContext tab wasn't found")
        self.shared = await cdp.Target(info).connect()
        return self.shared

    async def show_keyboard(self):
        try:
            await (await self.shared_context()).evaluate(SHOW_KEYBOARD_JS, timeout=3)
        except Exception as e:
            self.log.warning(f"On-screen keyboard: {e}")

    # -- lifecycle --

    def restart(self):
        self.restart_requested.set()

    async def run(self):
        """Create the view and keep it alive. Never returns."""
        backoff = 2
        while True:
            try:
                await self._create()
                backoff = 2
                await self._watch()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.log.warning(f"Discord view: {e}")
                await asyncio.sleep(backoff)
                backoff = min(30, backoff * 2)

    async def _create(self):
        diag.set("steam_ui", diag.PENDING, "connecting to Steam's UI debugger")
        while True:
            try:
                shared = await self.shared_context()
                break
            except Exception as e:
                diag.set("steam_ui", diag.WARN, f"waiting for Steam's UI: {e}")
                await asyncio.sleep(2)
        diag.set("steam_ui", diag.OK, "connected")

        diag.set("discord_view", diag.PENDING, "creating the Discord view")
        while True:
            try:
                kb = await shared.evaluate(CREATE_JS, timeout=8)
                break
            except cdp.JSError as e:
                diag.set("discord_view", diag.WARN, str(e))
                await asyncio.sleep(3)

        # Find the new view's DevTools target.
        info = None
        for _ in range(20):
            await asyncio.sleep(0.5)
            info = await cdp.find_target(lambda t: t.get("url") == PLACEHOLDER)
            if info:
                break
        if not info:
            raise RuntimeError("the Discord view was created but never appeared in the DevTools list")

        if self.target:
            await self.target.close()
        self.target = await cdp.Target(info).connect()
        self.target.on_event(self._page_event)
        await self.target.send("Page.enable")
        await self.target.send("Runtime.enable")

        source = await self._page_source()
        await self.target.send("Page.addScriptToEvaluateOnNewDocument", {"source": source, "runImmediately": True})
        await self.target.send("Page.navigate", {"url": "https://discord.com/app"})
        self.created_at = time.time()
        detail = "loading discord.com"
        if kb != "ok":
            detail += f" ({kb})"
        diag.set("discord_view", diag.OK, detail)

    async def _page_source(self):
        parts = [
            "Object.hasOwn = Object.hasOwn || ((o, p) => Object.prototype.hasOwnProperty.call(o, p));",
            await vencord.load(self.cache_dir),
        ]
        for name in PAGE_SCRIPTS:
            if name == "config":
                parts.append(f"window.DISCORDIO_CONFIG = {json.dumps(self.config)};")
            else:
                parts.append((self.dir / name).read_text())
        return "\n;\n".join(parts)

    async def _watch(self):
        """Return when the view needs recreating."""
        while True:
            try:
                await asyncio.wait_for(self.restart_requested.wait(), 2)
                self.restart_requested.clear()
                self.log.info("Discord view restart requested")
                diag.set("discord_view", diag.PENDING, "restarting")
                try:
                    await (await self.shared_context()).evaluate(DESTROY_JS, timeout=5)
                except Exception:
                    pass
                return
            except asyncio.TimeoutError:
                pass
            if not self.target or not self.target.connected:
                still = await cdp.find_target(lambda t: t.get("id") == (self.target and self.target.id))
                if still:
                    try:
                        await self.target.connect()
                        continue
                    except Exception:
                        pass
                diag.set("discord_view", diag.WARN, "the Discord view went away, recreating")
                return

    async def set_visible(self, visible):
        """Show or hide the Discord view (without giving it focus)."""
        js = ("(() => { const v = window.DISCORDIO_VIEW; if (!v || !v.m_browserView) return false; "
              f"v.m_browserView.SetVisible({'true' if visible else 'false'}); return true; }})()")
        return await (await self.shared_context()).evaluate(js, timeout=5)

    async def unlock_audio(self):
        """
        Let the Discord page play sound (ringing, joins, notifications).
        Chromium blocks audio until the user interacts with a page, and you
        rarely click into this one; a DevTools call marked as a user gesture
        counts as that interaction.
        """
        if not self.target or not self.target.connected:
            raise RuntimeError("the Discord view isn't connected")
        return await self.target.evaluate(
            "window.DISCORDIO_UNLOCK_AUDIO ? window.DISCORDIO_UNLOCK_AUDIO() : "
            "({activated: !!(navigator.userActivation && navigator.userActivation.hasBeenActive)})",
            timeout=5, user_gesture=True)

    def _page_event(self, method, params):
        # Page errors go to the log, so they show up in diagnostics and reports.
        if method == "Runtime.exceptionThrown":
            d = params.get("exceptionDetails", {})
            text = (d.get("exception") or {}).get("description") or d.get("text") or ""
            if "discordio" in text.lower() or "deckcord" in text.lower():
                diag.log_external("[page]", "exception: " + text.splitlines()[0][:300])
        elif method == "Runtime.consoleAPICalled":
            args = params.get("args", [])
            first = str(args[0].get("value", "")) if args else ""
            if first.startswith("[Discordio]"):
                text = " ".join(str(a.get("value", a.get("description", ""))) for a in args)
                diag.log_external("[page]", text[:300])
