from aiohttp.web import (  # type: ignore
    Application,
    get,
    WebSocketResponse,
    AppRunner,
    TCPSite,
    Response,
)
from asyncio import sleep, create_task, create_subprocess_exec, CancelledError
import aiohttp_cors  # type: ignore
from json import dumps, loads
from pathlib import Path
from subprocess import PIPE
from shutil import which
from traceback import format_exc
import os
import pwd
import sys

import decky  # type: ignore
from decky import logger, DECKY_PLUGIN_DIR, emit  # type: ignore
from logging import INFO

sys.path.append(DECKY_PLUGIN_DIR)

from tab_utils.tab import (
    create_discord_tab,
    setup_discord_tab,
    boot_discord,
    setOSK,
)
from tab_utils.cdp import Tab, get_tab
from discord_client.event_handler import EventHandler

logger.setLevel(INFO)

SETTINGS_DIR = Path(getattr(decky, "DECKY_PLUGIN_SETTINGS_DIR", DECKY_PLUGIN_DIR))
SETTINGS_FILE = SETTINGS_DIR / "settings.json"
RUNTIME_DIR = Path(getattr(decky, "DECKY_PLUGIN_RUNTIME_DIR", DECKY_PLUGIN_DIR))
QUALITY_PRESETS = {"720p30", "720p60", "1080p30", "1080p60", "1440p60", "source"}
DEFAULTS = {"stream_quality": "720p30"}


def load_settings():
    try:
        return {**DEFAULTS, **loads(SETTINGS_FILE.read_text())}
    except Exception:
        return dict(DEFAULTS)


def save_settings(settings):
    try:
        SETTINGS_DIR.mkdir(parents=True, exist_ok=True)
        SETTINGS_FILE.write_text(dumps(settings, indent=2))
    except Exception:
        logger.error("Could not save settings:\n" + format_exc())


def user_env():
    """
    Environment for talking to the logged-in user's PipeWire/PulseAudio.
    The original hardcoded the Steam Deck's `deck` user (uid 1000 and
    /home/deck), which is not guaranteed on a Steam Machine or other
    SteamOS installs.
    """
    user = getattr(decky, "DECKY_USER", None) or os.environ.get("DECKY_USER") or "deck"
    try:
        info = pwd.getpwnam(user)
        uid, home = info.pw_uid, info.pw_dir
    except KeyError:
        uid, home = 1000, getattr(decky, "DECKY_USER_HOME", "/home/deck")
    runtime = f"/run/user/{uid}"
    return {
        "DBUS_SESSION_BUS_ADDRESS": f"unix:path={runtime}/bus",
        "XDG_RUNTIME_DIR": runtime,
        "XDG_DATA_DIRS": f"{home}/.local/share/flatpak/exports/share:/var/lib/flatpak/exports/share:/usr/local/share:/usr/share",
    }


async def stream_watcher(stream, is_err=False):
    async for line in stream:
        line = line.decode("utf-8", "replace").rstrip()
        if not line:
            continue
        # Errors from the capture helper used to go to debug level and were
        # invisible in normal logs. They matter when testing streaming.
        if is_err:
            logger.warning("[capture] " + line)
        else:
            logger.info("[capture] " + line)


class Plugin:
    server = Application()
    cors = aiohttp_cors.setup(
        server,
        defaults={
            "*": aiohttp_cors.ResourceOptions(
                expose_headers="*", allow_headers="*", allow_credentials=True
            )
        },
    )
    evt_handler = EventHandler()
    last_ws: WebSocketResponse = None

    # Startup progress, shown in the QAM so a stuck start is visible
    # instead of an endless "Initializing...".
    stage = "Starting"
    error = None
    attempts = 0
    discord_tab: Tab = None
    init_task = None

    # ---- status ---------------------------------------------------------

    @classmethod
    def _status(cls, stage, error=None, attempt=0):
        changed = (stage, error) != (cls.stage, cls.error)
        cls.stage, cls.error, cls.attempts = stage, error, attempt
        if error:
            logger.warning(f"{stage}: {error}")
        elif changed:
            logger.info(stage)
        if changed:
            create_task(cls._emit_state())

    @classmethod
    async def _emit_state(cls):
        try:
            # Status-only update: must not consume a pending mic WebRTC offer.
            await emit("state", cls._state(cls.evt_handler.build_state_dict(consume_webrtc=False)))
        except Exception:
            pass

    @classmethod
    def _state(cls, base=None):
        s = base if base is not None else cls.evt_handler.build_state_dict()
        s["stage"] = "Ready" if s.get("loaded") else cls.stage
        s["error"] = None if s.get("loaded") else cls.error
        s["attempts"] = cls.attempts
        return s

    # ---- startup --------------------------------------------------------

    @classmethod
    async def _initialize(cls):
        tab = await create_discord_tab(cls._status)
        cls._status("Loading Vencord")
        await setup_discord_tab(tab, cache_dir=RUNTIME_DIR)
        cls._status("Opening discord.com")
        await boot_discord(tab)
        cls._status("Waiting for Discord to connect")
        cls.discord_tab = tab
        return tab

    @classmethod
    async def _run_discord(cls):
        """Create the Discord view and keep it alive. Never raises."""
        while True:
            try:
                tab = await cls._initialize()
                while True:
                    while not tab.websocket.closed:
                        await sleep(1)
                    logger.info("Discord tab websocket closed, reconnecting")
                    try:
                        await tab.open_websocket()
                    except Exception:
                        break
                cls._status("Discord view went away, recreating")
            except CancelledError:
                raise
            except Exception as e:
                cls._status("Starting Discord failed, retrying", f"{type(e).__name__}: {e}")
                logger.error(format_exc())
                await sleep(5)

    @classmethod
    async def _start_capture_helper(cls):
        python = "/usr/bin/python" if os.path.exists("/usr/bin/python") else (which("python3") or "python3")
        bundled = Path(DECKY_PLUGIN_DIR) / "bin"
        env = {
            **user_env(),
            "GST_VAAPI_ALL_DRIVERS": "1",
            "OPENSSL_CONF": "/etc/ssl/openssl.cnf",
            "LIBVA_DRIVER_NAME": "radeonsi",
            "DECKCORD_SETTINGS": str(SETTINGS_FILE),
            "PATH": "/usr/bin:/bin",
        }
        # Only point at bundled GStreamer libraries if this build ships them;
        # otherwise use the system's.
        if bundled.exists():
            env["LD_LIBRARY_PATH"] = str(bundled)
            env["GI_TYPELIB_PATH"] = str(bundled / "girepository-1.0")
            env["GST_PLUGIN_PATH"] = str(bundled / "gstreamer-1.0")
        try:
            cls.webrtc_server = await create_subprocess_exec(
                python,
                str(Path(DECKY_PLUGIN_DIR) / "gst_webrtc.py"),
                env=env,
                stdout=PIPE,
                stderr=PIPE,
            )
            create_task(stream_watcher(cls.webrtc_server.stdout))
            create_task(stream_watcher(cls.webrtc_server.stderr, True))
        except Exception:
            logger.error("Capture helper failed to start (Go Live will not work):\n" + format_exc())

    @classmethod
    async def _main(cls):
        logger.info("Starting Discordio backend")

        # The local server comes up first so the Discord page can always reach
        # us. Previously it only started after Discord finished loading, so any
        # failure there took everything down with it.
        cls.server.add_routes(
            [
                get("/openkb", cls._openkb),
                get("/socket", cls._websocket_handler),
            ]
        )
        for r in list(cls.server.router.routes())[:-1]:
            cls.cors.add(r)
        cls.runner = AppRunner(cls.server, access_log=None)
        await cls.runner.setup()
        # Loopback only. The original listened on 0.0.0.0, exposing the
        # Discord bridge to the whole local network.
        await TCPSite(cls.runner, "127.0.0.1", 65123).start()

        cls.init_task = create_task(cls._run_discord())
        create_task(cls._connect_shared_js())
        await cls._start_capture_helper()

        async for state in cls.evt_handler.yield_new_state():
            await emit("state", cls._state(state))

    @classmethod
    async def _connect_shared_js(cls):
        while True:
            try:
                cls.shared_js_tab = await get_tab("SharedJSContext")
                await cls.shared_js_tab.open_websocket()
                break
            except Exception:
                await sleep(1)
        create_task(cls._notification_dispatcher())

    # ---- local http endpoints ------------------------------------------

    @classmethod
    async def _openkb(cls, request):
        try:
            await cls.shared_js_tab.ensure_open()
            await setOSK(cls.shared_js_tab, True)
        except Exception:
            logger.warning("Could not open on-screen keyboard:\n" + format_exc())
        return Response(text="OK")

    @classmethod
    async def _websocket_handler(cls, request):
        logger.info("Discord page connected")
        ws = WebSocketResponse(max_msg_size=0)
        await ws.prepare(request)
        await cls.evt_handler.main(ws)
        return ws

    @classmethod
    async def _notification_dispatcher(cls):
        async for notification in cls.evt_handler.yield_notification():
            try:
                payload = dumps({"title": notification["title"], "body": notification["body"]})
                await cls.shared_js_tab.ensure_open()
                # Passed as a JSON literal, not inside a quoted string, so a
                # message containing ' or \ can no longer break (or inject into)
                # the evaluated JavaScript.
                await cls.shared_js_tab.evaluate(
                    f"window.DECKCORD && window.DECKCORD.dispatchNotification({payload});"
                )
            except Exception:
                logger.warning("Notification failed:\n" + format_exc())

    # ---- helpers --------------------------------------------------------

    @classmethod
    async def _send(cls, message):
        ws = getattr(cls.evt_handler, "ws", None)
        if ws is None or ws.closed:
            logger.info(f"Ignoring {message.get('type')}: Discord page not connected")
            return False
        await ws.send_json(message)
        return True

    # ---- frontend API ---------------------------------------------------

    @classmethod
    async def connect_ws(cls):
        await cls.shared_js_tab.ensure_open()
        await cls.shared_js_tab.evaluate("window.DECKCORD.connectWs()")

    @classmethod
    async def get_state(cls):
        return cls._state()

    @classmethod
    async def restart_discord(cls):
        logger.info("Restart requested from QAM")
        if cls.init_task:
            cls.init_task.cancel()
        cls.evt_handler.loaded = False
        cls.attempts = 0
        cls._status("Restarting")
        cls.init_task = create_task(cls._run_discord())
        return True

    @classmethod
    async def toggle_mute(cls):
        try:
            return await cls.evt_handler.toggle_mute(act=True)
        except Exception as e:
            logger.warning(f"toggle_mute: {e}")

    @classmethod
    async def toggle_deafen(cls):
        try:
            return await cls.evt_handler.toggle_deafen(act=True)
        except Exception as e:
            logger.warning(f"toggle_deafen: {e}")

    @classmethod
    async def disconnect_vc(cls):
        try:
            return await cls.evt_handler.disconnect_vc()
        except Exception as e:
            logger.warning(f"disconnect_vc: {e}")

    @classmethod
    async def set_ptt(cls, value):
        await cls._send({"type": "$ptt", "value": value})

    @classmethod
    async def enable_ptt(cls, enabled):
        await cls._send({"type": "$setptt", "enabled": enabled})

    @classmethod
    async def set_rpc(cls, game):
        await cls._send({"type": "$rpc", "game": game})

    @classmethod
    async def get_last_channels(cls):
        try:
            return await cls.evt_handler.api.get_last_channels()
        except Exception as e:
            logger.warning(f"get_last_channels: {e}")
            return {}

    @classmethod
    async def post_screenshot(cls, channel_id, data):
        logger.info("Posting screenshot to " + channel_id)
        try:
            if await cls.evt_handler.api.post_screenshot(channel_id, data):
                return True
        except Exception as e:
            logger.warning(f"post_screenshot: {e}")
        try:
            payload = dumps({"title": "Discordio", "body": "Error while posting screenshot"})
            await cls.shared_js_tab.ensure_open()
            await cls.shared_js_tab.evaluate(f"window.DECKCORD.dispatchNotification({payload});")
        except Exception:
            pass
        return False

    @classmethod
    async def get_screen_bounds(cls):
        return await cls.evt_handler.api.get_screen_bounds()

    @classmethod
    async def get_stream_quality(cls):
        return load_settings()["stream_quality"]

    @classmethod
    async def set_stream_quality(cls, quality):
        if quality not in QUALITY_PRESETS:
            return False
        settings = load_settings()
        settings["stream_quality"] = quality
        save_settings(settings)
        logger.info(f"Stream quality set to {quality}")
        return True

    @classmethod
    async def go_live(cls):
        return await cls._go_live(stop=False)

    @classmethod
    async def stop_go_live(cls):
        return await cls._go_live(stop=True)

    @classmethod
    async def _go_live(cls, stop):
        try:
            res = await cls.evt_handler.api.go_live(stop=stop)
        except Exception as e:
            logger.warning(f"go_live(stop={stop}): {e}")
            return {"ok": False, "error": str(e)}
        if isinstance(res, dict) and res.get("error"):
            logger.warning(f"go_live(stop={stop}) failed in Discord: {res['error']}")
            return {"ok": False, "error": res["error"]}
        method = res.get("method") if isinstance(res, dict) else None
        logger.info(f"go_live(stop={stop}) via {method}")
        try:
            await cls.evt_handler.toggle_mute()  # refreshes is_live in the state
        except Exception:
            pass
        return {"ok": True, "method": method}

    @classmethod
    async def mic_webrtc_answer(cls, answer):
        await cls._send({"type": "$webrtc", "payload": answer})

    @classmethod
    async def _unload(cls):
        if cls.init_task:
            cls.init_task.cancel()

        if hasattr(cls, "webrtc_server"):
            try:
                cls.webrtc_server.kill()
                await cls.webrtc_server.wait()
            except Exception:
                pass

        if hasattr(cls, "runner"):
            await cls.runner.shutdown()
            await cls.runner.cleanup()

        if hasattr(cls, "shared_js_tab"):
            try:
                await cls.shared_js_tab.ensure_open()
                await cls.shared_js_tab.evaluate(
                    """
                    if (window.DISCORD_TAB) {
                        window.DISCORD_TAB.m_browserView.SetVisible(false);
                        window.DISCORD_TAB.Destroy();
                        window.DISCORD_TAB = undefined;
                    }
                    """
                )
                await cls.shared_js_tab.close_websocket()
            except Exception:
                pass
