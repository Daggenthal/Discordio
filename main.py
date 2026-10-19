from aiohttp.web import (  # type: ignore
    Application,
    json_response,
    get,
    WebSocketResponse,
    AppRunner,
    TCPSite,
    Response,
)
from asyncio import sleep, create_task, create_subprocess_exec, CancelledError
import aiohttp_cors  # type: ignore
from json import dumps, loads
from base64 import b64encode
import re
from aiohttp import ClientSession, ClientTimeout  # type: ignore
from pathlib import Path
from subprocess import PIPE, STDOUT
import time
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
    _ssl_context,
    create_discord_tab,
    setup_discord_tab,
    boot_discord,
    setOSK,
)
from tab_utils.cdp import Tab, get_tab, get_tabs
from discord_client.event_handler import EventHandler

logger.setLevel(INFO)

SETTINGS_DIR = Path(getattr(decky, "DECKY_PLUGIN_SETTINGS_DIR", DECKY_PLUGIN_DIR))
SETTINGS_FILE = SETTINGS_DIR / "settings.json"
RUNTIME_DIR = Path(getattr(decky, "DECKY_PLUGIN_RUNTIME_DIR", DECKY_PLUGIN_DIR))
RESOLUTIONS = {"480", "720", "1080", "1440", "2160", "source"}
FRAME_RATES = {5, 10, 15, 24, 30, 45, 60}
LEGACY_PRESETS = {
    "720p30": ("720", 30), "720p60": ("720", 60), "1080p30": ("1080", 30),
    "1080p60": ("1080", 60), "1440p60": ("1440", 60), "source": ("source", 60),
}
DEFAULTS = {"stream_resolution": "720", "stream_fps": 30, "overlay_enabled": True, "overlay_position": "top-left", "overlay_engine": "auto"}
OVERLAY_POSITIONS = {"top-left", "top-right", "bottom-left", "bottom-right"}
RELEASES_API = "https://api.github.com/repos/Daggenthal/Discordio/releases?per_page=20"


def build_number(version):
    """CI builds are versioned like 0.1.0-build.42; local builds have no number."""
    m = re.search(r"build[.-](\d+)", version or "")
    return int(m.group(1)) if m else 0


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


CAPTURE_LOG = []  # last lines from the capture helper, shown when it fails


async def stream_watcher(stream, is_err=False):
    async for line in stream:
        line = line.decode("utf-8", "replace").rstrip()
        if not line:
            continue
        CAPTURE_LOG.append(line)
        del CAPTURE_LOG[:-20]
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
                get("/overlay", cls._overlay_state),
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
        cls.overlay_task = create_task(cls._run_overlay())

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

    # ---- in-game overlay -----------------------------------------------

    overlay_proc = None
    overlay_status = "not started"
    overlay_task = None

    @staticmethod
    def _steam_display():
        """
        DISPLAY and XAUTHORITY of the running Steam client, so the overlay
        lands on the same gamescope X server Steam uses.
        """
        user = getattr(decky, "DECKY_USER", None) or "deck"
        try:
            uid = pwd.getpwnam(user).pw_uid
        except KeyError:
            uid = 1000
        for pid in os.listdir("/proc"):
            if not pid.isdigit():
                continue
            try:
                if os.stat(f"/proc/{pid}").st_uid != uid:
                    continue
                with open(f"/proc/{pid}/comm") as f:
                    if f.read().strip() not in ("steam", "steamwebhelper"):
                        continue
                with open(f"/proc/{pid}/environ", "rb") as f:
                    env = dict(
                        kv.split(b"=", 1) for kv in f.read().split(b"\0") if b"=" in kv
                    )
                if b"DISPLAY" in env:
                    out = {"DISPLAY": env[b"DISPLAY"].decode()}
                    if b"XAUTHORITY" in env:
                        out["XAUTHORITY"] = env[b"XAUTHORITY"].decode()
                    return out
            except Exception:
                continue
        return {"DISPLAY": ":0"}

    @staticmethod
    def _mangoapp_running():
        """Steam's performance overlay runs as mangoapp while it's shown."""
        for pid in os.listdir("/proc"):
            if pid.isdigit():
                try:
                    with open(f"/proc/{pid}/comm") as f:
                        if f.read().strip() == "mangoapp":
                            return True
                except Exception:
                    pass
        return False

    @classmethod
    def _active_engine(cls, settings=None):
        """
        gamescope composites only ONE external overlay, and Steam's performance
        overlay (MangoHud's mangoapp) uses it. "auto" therefore draws inside
        Steam's own overlay layer while the performance overlay is up, and
        uses the gamescope overlay otherwise.
        """
        s = settings or load_settings()
        if not s.get("overlay_enabled", True):
            return None
        engine = s.get("overlay_engine", "auto")
        if engine == "auto":
            return "steam" if cls._mangoapp_running() else "gamescope"
        return engine if engine in ("gamescope", "steam") else "gamescope"

    @classmethod
    async def _run_overlay(cls):
        """Start/stop the right overlay engine as settings and mangoapp change. Never raises."""
        failures, retry_at = 0, 0.0
        create_task(cls._run_steam_layer())
        while True:
            try:
                active = cls._active_engine()
                proc = cls.overlay_proc
                running = proc is not None and proc.returncode is None
                if active == "gamescope":
                    if not running and time.monotonic() >= retry_at:
                        await cls._start_gamescope_overlay()
                elif running:
                    # Free gamescope's overlay slot (e.g. for the performance overlay).
                    await cls._stop_overlay()
                if active is None:
                    cls.overlay_status = "off"
                elif active == "steam":
                    cls.overlay_status = cls.steam_layer_status
                proc = cls.overlay_proc
                if proc is not None and proc.returncode is not None:
                    code = proc.returncode
                    cls.overlay_proc = None
                    if code not in (0, -15) and active == "gamescope":
                        failures += 1
                        retry_at = time.monotonic() + min(60, 3 * failures)
                        cls.overlay_status = f"stopped (exit {code}): {cls.overlay_last_line[-160:]}"
                        logger.warning(f"Overlay exited with {code}")
                elif proc is not None:
                    failures = 0
                await sleep(1)
            except CancelledError:
                raise
            except Exception as e:
                cls.overlay_status = f"error: {e}"
                logger.error("Overlay manager:\n" + format_exc())
                await sleep(5)

    overlay_last_line = ""

    @classmethod
    async def _start_gamescope_overlay(cls):
        python = "/usr/bin/python" if os.path.exists("/usr/bin/python") else (which("python3") or "python3")
        env = {
            **user_env(),
            **cls._steam_display(),
            "PATH": "/usr/bin:/bin",
            "DISCORDIO_CACHE": str(RUNTIME_DIR / "avatars"),
            "PYTHONUNBUFFERED": "1",
        }
        cls.overlay_status = f"running on {env['DISPLAY']}"
        logger.info(f"Starting gamescope overlay on DISPLAY={env['DISPLAY']}")
        cls.overlay_proc = await create_subprocess_exec(
            python, str(Path(DECKY_PLUGIN_DIR) / "overlay.py"),
            env=env, stdout=PIPE, stderr=STDOUT,
        )

        async def pump(proc):
            async for line in proc.stdout:
                text = line.decode("utf-8", "replace").rstrip()
                if text:
                    cls.overlay_last_line = text
                    logger.info(text if text.startswith("[overlay]") else "[overlay] " + text)
            await proc.wait()

        create_task(pump(cls.overlay_proc))

    # ---- "Steam layer" engine: drawn inside Steam's own overlay window ----

    STEAM_LAYER_TABS = ("notificationtoasts",)
    steam_layer_status = "waiting for Steam's overlay window"
    steam_layer_tabs = set()

    @classmethod
    async def _run_steam_layer(cls):
        script = None
        stop = "window.__discordioOverlayStop ? window.__discordioOverlayStop() : 'not running'"
        while True:
            try:
                if script is None:
                    script = (Path(DECKY_PLUGIN_DIR) / "overlay_web.js").read_text()
                want = cls._active_engine() == "steam"
                tabs = [t for t in await get_tabs() if t.title.lower().startswith(cls.STEAM_LAYER_TABS)]
                injected = set()
                for tab in tabs:
                    try:
                        await tab.open_websocket()
                        try:
                            if want:
                                _, err = await tab.evaluate_value(script)
                                if err:
                                    raise RuntimeError(err)
                                injected.add(tab.title)
                            elif tab.title in cls.steam_layer_tabs:
                                await tab.evaluate_value(stop)
                        finally:
                            await tab.close_websocket()
                    except Exception as e:
                        logger.warning(f"Steam-layer overlay on {tab.title}: {e}")
                if want:
                    if injected != cls.steam_layer_tabs:
                        logger.info(f"Steam-layer overlay in: {sorted(injected) or 'nothing'}")
                    cls.steam_layer_status = (
                        f"running in Steam's overlay ({len(injected)} window{'s' if len(injected) != 1 else ''})"
                        if injected else "waiting for Steam's overlay window"
                    )
                cls.steam_layer_tabs = injected if want else set()
            except CancelledError:
                raise
            except Exception as e:
                cls.steam_layer_status = f"error: {e}"
            await sleep(3)

    @classmethod
    async def _stop_overlay(cls):
        proc = cls.overlay_proc
        if proc and proc.returncode is None:
            try:
                proc.terminate()
                await proc.wait()
            except Exception:
                pass

    @classmethod
    async def _overlay_state(cls, request):
        settings = load_settings()
        return json_response({
            **(cls.evt_handler.overlay_state or {}),
            "settings": {
                "overlay_enabled": settings.get("overlay_enabled", True),
                "overlay_position": settings.get("overlay_position", "top-left"),
                "overlay_engine_active": cls._active_engine(settings),
            },
        }, headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"})

    @classmethod
    async def get_overlay_settings(cls):
        s = load_settings()
        return {
            "enabled": s.get("overlay_enabled", True),
            "position": s.get("overlay_position", "top-left"),
            "engine": s.get("overlay_engine", "auto"),
            "active": cls._active_engine(s),
            "status": cls.overlay_status,
        }

    @classmethod
    async def set_overlay_settings(cls, enabled=None, position=None, engine=None):
        s = load_settings()
        if engine in ("auto", "gamescope", "steam"):
            s["overlay_engine"] = engine
        if enabled is not None:
            s["overlay_enabled"] = bool(enabled)
        if position in OVERLAY_POSITIONS:
            s["overlay_position"] = position
        save_settings(s)
        if enabled is False:
            cls.overlay_status = "off"
            await cls._stop_overlay()
        elif enabled is True and not cls.overlay_status.startswith("running"):
            cls.overlay_status = "starting"
        return await cls.get_overlay_settings()

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
        # Discord's own action first (works for server channels and DM calls),
        # then the original raw event as a fallback.
        try:
            res = await cls.evt_handler.api._store_access_request("$disconnect_voice", timeout=5)
            if not (isinstance(res, dict) and res.get("error")):
                return res
        except Exception as e:
            logger.warning(f"disconnect via page: {e}")
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
    async def _ensure_capture_helper(cls):
        """Restart the capture helper if it isn't running. Returns an error or None."""
        proc = getattr(cls, "webrtc_server", None)
        if proc is not None and proc.returncode is None:
            return None
        last = CAPTURE_LOG[-1] if CAPTURE_LOG else "no output"
        logger.warning(f"Capture helper not running (last output: {last}), restarting")
        CAPTURE_LOG.clear()
        await cls._start_capture_helper()
        await sleep(2)
        proc = getattr(cls, "webrtc_server", None)
        if proc is None or proc.returncode is not None:
            return "Capture helper won't start: " + (" | ".join(CAPTURE_LOG[-3:]) or "unknown error")
        return None

    @classmethod
    async def get_capture_log(cls):
        proc = getattr(cls, "webrtc_server", None)
        running = proc is not None and proc.returncode is None
        return {"running": running, "lines": CAPTURE_LOG[-12:]}

    @classmethod
    async def get_stream_preview(cls):
        """
        One JPEG frame of what Go Live captures, as a data URL. Goes through the
        backend because the QAM page can't reliably fetch the helper directly.
        """
        error = await cls._ensure_capture_helper()
        if error:
            return {"error": error}
        try:
            async with ClientSession(timeout=ClientTimeout(total=8)) as session:
                res = await session.get("http://127.0.0.1:65124/preview")
                body = await res.read()
                if res.status != 200:
                    return {"error": body.decode("utf-8", "replace")[:300] or f"HTTP {res.status}"}
        except Exception as e:
            return {"error": f"Capture helper unreachable: {type(e).__name__}: {e}"}
        return {"image": "data:image/jpeg;base64," + b64encode(body).decode()}

    @classmethod
    async def get_stream_settings(cls):
        try:
            raw = loads(SETTINGS_FILE.read_text())
        except Exception:
            raw = {}
        if "stream_resolution" not in raw and raw.get("stream_quality") in LEGACY_PRESETS:
            # Migrate the old combined presets (720p30 and friends).
            res, fps = LEGACY_PRESETS[raw["stream_quality"]]
        else:
            res, fps = str(raw.get("stream_resolution", "720")), raw.get("stream_fps", 30)
        return {"resolution": res if res in RESOLUTIONS else "720", "fps": fps if fps in FRAME_RATES else 30}

    @classmethod
    async def set_stream_settings(cls, resolution=None, fps=None):
        current = await cls.get_stream_settings()  # includes a migrated old preset
        s = load_settings()
        s["stream_resolution"], s["stream_fps"] = current["resolution"], current["fps"]
        if resolution is not None and str(resolution) in RESOLUTIONS:
            s["stream_resolution"] = str(resolution)
        if fps is not None:
            try:
                fps = int(fps)
            except Exception:
                fps = None
            if fps in FRAME_RATES:
                s["stream_fps"] = fps
        s.pop("stream_quality", None)
        save_settings(s)
        logger.info(f"Stream set to {s.get('stream_resolution')} @ {s.get('stream_fps')} fps")
        return await cls.get_stream_settings()

    @classmethod
    async def get_audio_outputs(cls):
        try:
            return await cls.evt_handler.api._store_access_request("$audio_devices", timeout=5)
        except Exception as e:
            return {"error": str(e)}

    @classmethod
    async def set_audio_output(cls, device_id):
        try:
            return await cls.evt_handler.api._store_access_request("$set_audio_output", id=device_id, timeout=5)
        except Exception as e:
            return {"error": str(e)}

    @classmethod
    async def get_stream_limits(cls):
        """What the logged-in account (and current server's boosts) allow."""
        try:
            return await cls.evt_handler.api._store_access_request("$stream_limits", timeout=5)
        except Exception as e:
            return {"error": str(e)}

    @classmethod
    async def go_live(cls):
        return await cls._go_live(stop=False)

    @classmethod
    async def stop_go_live(cls):
        return await cls._go_live(stop=True)

    @classmethod
    async def _go_live(cls, stop):
        started = time.time()
        if not stop:
            error = await cls._ensure_capture_helper()
            if error:
                return {"ok": False, "error": error}
        try:
            res = await cls.evt_handler.api.go_live(stop=stop, quality=None if stop else await cls.get_stream_settings())
        except Exception as e:
            logger.warning(f"go_live(stop={stop}): {e}")
            return {"ok": False, "error": str(e)}
        if isinstance(res, dict) and res.get("error"):
            logger.warning(f"go_live(stop={stop}) failed in Discord: {res['error']}")
            return {"ok": False, "error": res["error"]}
        method = res.get("method") if isinstance(res, dict) else None
        logger.info(f"go_live(stop={stop}) via {method}")
        if not stop:
            # Discord starts the stream first and asks for the capture after,
            # so watch briefly for the capture failing or the stream going live.
            for _ in range(16):
                await sleep(0.5)
                err = cls.evt_handler.capture_error
                if err and err[0] >= started:
                    return {"ok": False, "error": f"Screen capture failed: {err[1]}"}
                try:
                    media = await cls.evt_handler.api.get_media()
                    if media.get("live"):
                        break
                except Exception:
                    pass
        try:
            await cls.evt_handler.toggle_mute()  # refreshes is_live in the state
        except Exception:
            pass
        return {"ok": True, "method": method}

    @classmethod
    async def discord_nav(cls, action):
        try:
            return await cls.evt_handler.api._store_access_request("$nav", action=action, timeout=5)
        except Exception as e:
            return {"handled": False, "error": str(e)}

    @classmethod
    async def discord_query(cls, what, arg=None):
        """Read-only lists for the QAM: servers, voice channels, friends."""
        try:
            return await cls.evt_handler.api._store_access_request("$query", what=what, arg=arg, timeout=10)
        except Exception as e:
            logger.warning(f"discord_query({what}): {e}")
            return {"error": str(e)}

    @classmethod
    async def join_voice(cls, channel_id):
        try:
            return await cls.evt_handler.api._store_access_request("$join_voice", channel_id=channel_id, timeout=15)
        except Exception as e:
            return {"error": str(e)}

    @classmethod
    async def call_friend(cls, user_id):
        try:
            return await cls.evt_handler.api._store_access_request("$call_friend", user_id=user_id, timeout=20)
        except Exception as e:
            return {"error": str(e)}

    @classmethod
    async def get_update_info(cls):
        """
        Look for a newer CI build on GitHub. The QAM then hands the zip URL to
        Decky's own installer, which swaps the plugin in place and reloads it,
        so updating never needs Desktop Mode or a Decky restart.
        """
        current = getattr(decky, "DECKY_PLUGIN_VERSION", "") or ""
        info = {"current": current, "current_build": build_number(current), "available": False}
        try:
            async with ClientSession(timeout=ClientTimeout(total=15)) as session:
                res = await session.get(
                    RELEASES_API,
                    ssl=_ssl_context(),
                    headers={"Accept": "application/vnd.github+json", "User-Agent": "Discordio"},
                )
                if not res.ok:
                    info["error"] = f"GitHub returned HTTP {res.status}"
                    return info
                releases = await res.json()
        except Exception as e:
            info["error"] = f"{type(e).__name__}: {e}"
            return info

        best = None
        for rel in releases:
            if rel.get("draft"):
                continue
            n = build_number(rel.get("tag_name", ""))
            asset = next((a for a in rel.get("assets", []) if a.get("name", "").endswith(".zip")), None)
            if n and asset and (best is None or n > best[0]):
                best = (n, rel, asset)

        if best:
            n, rel, asset = best
            info.update(
                latest=rel.get("name") or rel.get("tag_name"),
                latest_build=n,
                version=f"build.{n}",
                url=asset["browser_download_url"],
                notes=(rel.get("body") or "")[:400],
                available=n > info["current_build"],
            )
        return info

    @classmethod
    async def mic_webrtc_answer(cls, answer):
        await cls._send({"type": "$webrtc", "payload": answer})

    @classmethod
    async def _unload(cls):
        if cls.init_task:
            cls.init_task.cancel()
        if cls.overlay_task:
            cls.overlay_task.cancel()
        await cls._stop_overlay()

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
