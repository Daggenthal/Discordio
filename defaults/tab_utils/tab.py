from pathlib import Path
from os import path as ospath
from ssl import create_default_context

from aiohttp import ClientSession  # type: ignore
from .cdp import Tab, get_tab, get_tab_lambda
from asyncio import sleep

DISCORD_PLACEHOLDER_URL = "data:text/plain,to_be_discord"

# Runs inside Steam's SharedJSContext. Returns a short status string, or throws
# with a readable message, so the backend can show exactly which step broke.
#
# The router comes from window.DECKCORD_ROUTER (set by our frontend) first,
# then window.DFL (older Decky builds). Relying on DFL alone breaks on Decky
# versions that no longer expose it.
CREATE_TAB_JS = r"""
(() => {
    const Router = window.DECKCORD_ROUTER || (window.DFL && window.DFL.Router);
    if (!Router) throw new Error("No Steam router yet (frontend not loaded?)");
    const ws = Router.WindowStore;
    if (!ws) throw new Error("Router.WindowStore missing");
    const main = ws.GamepadUIMainWindowInstance;
    if (!main) throw new Error("GamepadUIMainWindowInstance missing (not in Game Mode?)");
    if (typeof main.CreateBrowserView !== "function")
        throw new Error("CreateBrowserView is not available on this Steam build");

    if (window.DISCORD_TAB !== undefined) {
        try {
            window.DISCORD_TAB.m_browserView.SetVisible(false);
            window.DISCORD_TAB.Destroy();
        } catch (e) {}
        window.DISCORD_TAB = undefined;
    }

    const tab = main.CreateBrowserView("discord");
    if (!tab || !tab.m_browserView) throw new Error("CreateBrowserView returned no browser view");
    window.DISCORD_TAB = tab;

    const bw = main.BrowserWindow;
    tab.WIDTH = (bw && bw.innerWidth) || 1280;
    tab.HEIGHT = (bw && bw.innerHeight) || 800;
    tab.m_browserView.SetBounds(0, 0, tab.WIDTH, tab.HEIGHT);
    tab.m_browserView.LoadURL("%s");

    // Shrink Discord while the on-screen keyboard is open. Optional: if Valve
    // moved this, Discord still works, the keyboard just overlaps it.
    try {
        main.m_VirtualKeyboardManager.IsShowingVirtualKeyboard.m_callbacks.m_vecCallbacks.push((shown) => {
            const t = window.DISCORD_TAB;
            if (!t) return;
            const h = shown ? Math.round(t.HEIGHT * 0.6) : t.HEIGHT;
            const b = t.m_browserView.GetBounds();
            if (b.height != h) t.m_browserView.SetBounds(0, 0, t.WIDTH, h);
        });
        return "created";
    } catch (e) {
        return "created (keyboard resize hook unavailable)";
    }
})()
""" % DISCORD_PLACEHOLDER_URL


async def create_discord_tab(status=lambda stage, error=None, attempt=0: None):
    status("Connecting to Steam UI")
    while True:
        try:
            tab = await get_tab("SharedJSContext")
            break
        except Exception:
            await sleep(0.5)

    await tab.open_websocket()

    attempt = 0
    while True:
        attempt += 1
        status("Creating Discord view", None, attempt)
        try:
            value, error = await tab.evaluate_value(CREATE_TAB_JS)
        except Exception as e:
            value, error = None, f"{type(e).__name__}: {e}"

        if error:
            status("Creating Discord view", error, attempt)
            await sleep(3)
            # The SharedJSContext websocket can drop across Steam UI reloads.
            try:
                await tab.ensure_open()
            except Exception:
                pass
            continue

        status(f"Discord view {value}, waiting for it to appear", None, attempt)
        for _ in range(10):
            await sleep(0.5)
            try:
                discord_tab = await get_tab_lambda(lambda t: t.url == DISCORD_PLACEHOLDER_URL)
                await tab.close_websocket()
                return discord_tab
            except Exception:
                pass

        status("Creating Discord view", "View was created but never showed up in the debugger tab list", attempt)


VENCORD_URL = "https://raw.githubusercontent.com/Vencord/builds/main/browser.js"


def _ssl_context():
    # /etc/ssl/cert.pem is what SteamOS ships; fall back to the system default.
    for cafile in ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"):
        if ospath.exists(cafile):
            return create_default_context(cafile=cafile)
    return create_default_context()


async def fetch_vencord(cache_dir=None):
    """
    Download Vencord. A copy is cached so a network hiccup at boot doesn't
    leave Discord without the hooks this plugin depends on.
    """
    cache = Path(cache_dir) / "vencord-browser.js" if cache_dir else None
    try:
        async with ClientSession() as session:
            res = await session.get(VENCORD_URL, ssl=_ssl_context())
            if res.ok:
                text = await res.text()
                if cache:
                    try:
                        cache.parent.mkdir(parents=True, exist_ok=True)
                        cache.write_text(text)
                    except Exception:
                        pass
                return text
            error = f"HTTP {res.status}"
    except Exception as e:
        error = f"{type(e).__name__}: {e}"

    if cache and cache.exists():
        return cache.read_text()
    raise RuntimeError(f"Could not download Vencord ({error}) and no cached copy exists")


async def setup_discord_tab(tab: Tab, cache_dir=None):
    await tab.open_websocket()
    await tab.enable()
    plugin_dir = Path(__file__).parent.parent
    source = (
        "Object.hasOwn = Object.hasOwn || ((obj, prop) => Object.prototype.hasOwnProperty.call(obj, prop));\n"
        + await fetch_vencord(cache_dir)
        + "\n"
        + (plugin_dir / "deckcord_client.js").read_text()
        + "\n"
        + (plugin_dir / "webrtc_client.js").read_text()
    )
    await tab._send_devtools_cmd({
        "method": "Page.addScriptToEvaluateOnNewDocument",
        "params": {"source": source, "runImmediately": True},
    })


async def boot_discord(tab: Tab):
    await tab._send_devtools_cmd({
        "method": "Page.navigate",
        "params": {
            "url": "https://discord.com/app",
            "transitionType": "address_bar"
        }
    })


async def setOSK(tab: Tab, state):
    if state:
        await tab.evaluate("DISCORD_TAB.m_virtualKeyboardHost.m_showKeyboard()")
    else:
        await tab.evaluate("DISCORD_TAB.m_virtualKeyboardHost.m_hideKeyboard()")
