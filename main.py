"""
Discordio: Discord in SteamOS Game Mode.

This is the Decky backend. It wires together:

  steam_view   the Discord browser view inside Steam's UI
  bridge       a typed request / event channel to the Discord page
  capture_mgr  the screen capture helper used by Go Live
  overlay_mgr  the in-game voice overlay
  diag         health of every part, recent errors, logs, reports

Methods on Plugin are what the QAM calls.
"""

import asyncio
import base64
import json
import os
import platform
import sys
import time
from pathlib import Path

import decky  # type: ignore
from aiohttp.web import AppRunner, Application, Response, TCPSite, get, json_response  # type: ignore

sys.path.append(decky.DECKY_PLUGIN_DIR)

from discordio import diag, system, updates  # noqa: E402
from discordio.bridge import Bridge, BridgeError  # noqa: E402
from discordio.capture_mgr import CaptureManager  # noqa: E402
from discordio.overlay_mgr import OverlayManager  # noqa: E402
from discordio.messages import Messages  # noqa: E402
from discordio.screenshots import Screenshots  # noqa: E402
from discordio.settings import (  # noqa: E402
    FRAME_RATES, MESSAGE_DURATIONS, OVERLAY_ENGINES, OVERLAY_POSITIONS, RESOLUTIONS, Settings,
)
from discordio.steam_view import DiscordView  # noqa: E402

log = decky.logger
log.setLevel("INFO")
diag.install_log_handler(log)

PLUGIN_DIR = Path(decky.DECKY_PLUGIN_DIR)
SETTINGS_DIR = Path(getattr(decky, "DECKY_PLUGIN_SETTINGS_DIR", PLUGIN_DIR))
RUNTIME_DIR = Path(getattr(decky, "DECKY_PLUGIN_RUNTIME_DIR", PLUGIN_DIR))
VERSION = getattr(decky, "DECKY_PLUGIN_VERSION", "dev")


def frontend_state(state, bridge_ready, stage):
    """The state shape the QAM components use."""
    s = state or {}
    user = s.get("user") or {}
    media = s.get("media") or {}
    voice = s.get("voice")
    return {
        "loaded": bool(bridge_ready),
        "logged_in": bool(s.get("loggedIn")),
        "me": {
            "id": user.get("id", ""),
            "username": user.get("name", ""),
            "handle": user.get("handle"),
            "avatar": user.get("avatar"),
            "is_muted": bool(media.get("mute")),
            "is_deafened": bool(media.get("deaf")),
            "is_live": bool(media.get("live")),
        },
        "vc": ({"channel_name": voice["channel_name"], "guild_name": voice["guild_name"], "users": voice["members"]}
               if voice else {}),
        "voice": voice,
        "status": s.get("status"),
        "stage": stage,
        "error": None,
        "attempts": 0,
    }


_PRIVATE_KEYS = {"name", "username", "global_name", "channel_name", "guild_name", "label",
                 "channel_label", "group", "title", "author", "plan", "reason"}


def _collect_private(obj, depth=0):
    """Remember names in Discord data so diagnostics can hide them (see diag.redact)."""
    if depth > 6:
        return
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in _PRIVATE_KEYS and isinstance(v, str) and k not in ("plan", "reason"):
                diag.remember_private(v)
            elif isinstance(v, (dict, list)):
                _collect_private(v, depth + 1)
    elif isinstance(obj, list):
        for v in obj[:500]:
            _collect_private(v, depth + 1)


PIP_FPS = (10, 30, 40, 60)


class Plugin:
    settings = None
    bridge = None
    view = None
    capture = None
    overlay = None
    runner = None
    tasks = []
    state = None          # last state from the Discord page
    ready = False         # page bridge said hello
    gamepads = None
    incoming = None       # a call ringing us right now
    captcha = False       # Discord is showing a human check
    call_hint = "Answer or decline in Discordio (Quick Access Menu)"
    capture_events = []   # recent screen-capture events from the page
    mic_events = []
    port = None

    # ------------------------------------------------------------- lifecycle

    @classmethod
    async def _main(cls):
        log.info(f"Discordio {VERSION} starting")
        for d in (SETTINGS_DIR, RUNTIME_DIR):
            d.mkdir(parents=True, exist_ok=True)
        cls.settings = Settings(SETTINGS_DIR)
        cls.messages = Messages(cls.settings)
        # One-time reset to 720p: the resolution slider was stuck at 480p,
        # its lowest position; starting mid-range shows whether it moves.
        _s = cls.settings.load()
        if not _s.get("resolution_reset_v1"):
            cls.settings.update(stream_resolution="720", resolution_reset_v1=True)
        cls.screenshots = Screenshots(system.session_user(decky)[2])
        cls.bridge = Bridge(log)
        cls.bridge.on("hello", cls._on_hello)
        cls.bridge.on("state", cls._on_state)
        cls.bridge.on("disconnected", cls._on_disconnected)
        cls.bridge.on("message", cls._on_message)
        cls.bridge.on("keyboard", lambda _: cls.view.show_keyboard())
        cls.bridge.on("mic", cls._on_mic)
        cls.bridge.on("capture", cls._on_capture)
        cls.bridge.on("sound_blocked", cls._on_sound_blocked)
        cls.bridge.on("rtc", cls._on_rtc)
        cls.bridge.on("pip_frame", cls._on_pip_frame)
        cls.bridge.on("pip", cls._on_pip)
        cls.bridge.on("watch_ended", cls._on_watch_ended)
        cls.bridge.on("call_incoming", cls._on_call_incoming)
        cls.bridge.on("call_ended", cls._on_call_ended)
        cls.bridge.on("captcha", cls._on_captcha)
        cls.bridge.on("mic_level", cls._on_mic_level)
        diag.set("call", diag.OFF, "not in a call")
        diag.set("controller", diag.OFF, "no shortcuts set")
        from discordio.gamepad import Gamepads
        loop_ = asyncio.get_running_loop()

        def pad_changed(path, name, mask):
            loop_.create_task(decky.emit("pad", {"device": path, "name": name, "mask": str(mask)}))

        cls.gamepads = Gamepads(pad_changed, log)

        # Local server: the bridge, plus overlay state for the overlay engines.
        cls.port = system.free_port(65123)
        app = Application()
        app.add_routes([
            get("/bridge", cls.bridge.handle),
            get("/overlay", cls._http_overlay),
            get("/overlay/pip.jpg", cls._http_pip),
            get("/health", lambda r: json_response({"ok": True, "version": VERSION})),
        ])
        cls.runner = AppRunner(app, access_log=None)
        await cls.runner.setup()
        await TCPSite(cls.runner, "127.0.0.1", cls.port).start()
        log.info(f"Local server on 127.0.0.1:{cls.port}")

        cls.capture = CaptureManager(decky, PLUGIN_DIR, RUNTIME_DIR, cls.settings, log)
        cls.overlay = OverlayManager(decky, PLUGIN_DIR, RUNTIME_DIR, cls.settings,
                                     f"http://127.0.0.1:{cls.port}/overlay", log)
        cls.overlay.call_active = lambda: bool((cls.state or {}).get("voice") or cls.incoming)
        loop = asyncio.get_running_loop()
        cls.tasks = [loop.create_task(cls.capture.run()), loop.create_task(cls.overlay.run())]
        # The page needs the capture helper's port, which is known once it starts.
        for _ in range(50):
            if cls.capture.port:
                break
            await asyncio.sleep(0.1)
        cls.view = DiscordView(PLUGIN_DIR, RUNTIME_DIR, {
            "version": VERSION,
            "bridgeUrl": f"ws://127.0.0.1:{cls.port}/bridge",
            "captureUrl": f"ws://127.0.0.1:{cls.capture.port}/webrtc",
        }, log)
        cls.tasks.append(loop.create_task(cls.view.run()))
        cls.tasks.append(loop.create_task(cls._heartbeat()))
        cls.tasks.append(loop.create_task(cls._usage_loop()))

        async def capture_port_changed(port):
            # The page (and future reloads of it) must use the helper's current address.
            url = f"ws://127.0.0.1:{port}/webrtc"
            cls.view.config["captureUrl"] = url
            await cls.bridge.push("config", {"captureUrl": url})

        cls.capture.on_port = capture_port_changed
        diag.on_change(lambda: loop.create_task(cls._emit_diag()))

    @classmethod
    async def _unload(cls):
        for t in cls.tasks:
            t.cancel()
        try:
            cls.gamepads.stop()
        except Exception:
            pass
        if cls.capture:
            await cls.capture.stop()
        if cls.overlay:
            await cls.overlay.stop()
            try:
                cls.overlay._restore_perf()  # unloading mid-call: give the FPS overlay back
            except Exception:
                pass
        if cls.view and cls.view.shared:
            try:
                from discordio.steam_view import DESTROY_JS
                await cls.view.shared.evaluate(DESTROY_JS, timeout=3)
                await cls.view.shared.close()
            except Exception:
                pass
        if cls.runner:
            await cls.runner.cleanup()

    @classmethod
    async def _heartbeat(cls):
        """Ping the page now and then so a wedged bridge shows up in diagnostics."""
        n = 0
        while True:
            await asyncio.sleep(5)
            n += 1
            if not (cls.bridge.connected and cls.ready):
                continue
            if n % 3 == 0:
                try:
                    await cls.bridge.request("ping", timeout=5)
                except Exception:
                    diag.set("bridge", diag.WARN, "Discord page stopped answering pings")
            try:
                await cls._check_call()
            except Exception as e:
                diag.set("call", diag.WARN, f"couldn't read call stats: {e}")

    _call_prev = None

    @classmethod
    def _call_summary(cls, peers):
        """Discord's own connections only (not Discordio's local mic/capture links)."""
        discord = [p for p in peers or [] if p.get("who") == "discord"]
        audio_out = sum(((p.get("sent") or {}).get("audio") or {}).get("bytes", 0) for p in discord)
        audio_in = sum(((p.get("received") or {}).get("audio") or {}).get("bytes", 0) for p in discord)
        video_out = sum(((p.get("sent") or {}).get("video") or {}).get("bytes", 0) for p in discord)
        mic_level = max([((p.get("sent") or {}).get("micLevel") or 0) for p in discord] or [0])
        return {"peers": discord, "audio_out": audio_out, "audio_in": audio_in,
                "video_out": video_out, "mic_level": mic_level}

    @classmethod
    async def _check_call(cls):
        """Is audio actually flowing in the call? Shown as "Call connection" in Diagnostics."""
        if not (cls.state or {}).get("voice"):
            cls._call_prev = None
            diag.set("call", diag.OFF, "not in a call")
            return
        now = cls._call_summary(await cls.bridge.request("rtcStats", timeout=5))
        prev, cls._call_prev = cls._call_prev, now
        states = ", ".join(sorted({p.get("state", "?") for p in now["peers"]})) or "none"
        path = next((p.get("path") for p in now["peers"] if p.get("path")), None)
        if not now["peers"]:
            diag.set("call", diag.ERROR, "in a call, but Discord opened no voice connection")
            return
        if all(p.get("state") in ("failed", "disconnected", "closed") for p in now["peers"]):
            diag.set("call", diag.ERROR, f"Discord's voice connection {states}: no audio can get through")
            return
        if prev is None:
            diag.set("call", diag.PENDING, f"voice connection {states}, measuring...")
            return
        st = cls.state or {}
        media = st.get("media") or {}
        others = max(0, len((st.get("voice") or {}).get("members") or []) - 1)
        sending = now["audio_out"] > prev["audio_out"]
        receiving = now["audio_in"] > prev["audio_in"]
        talking = now["mic_level"] >= 0.02
        bits = [f"voice connection {states}" + (f" via {path}" if path else "")]
        problems = []
        # Discord only sends audio while you talk (voice activity), so a quiet
        # mic with nothing sent is normal; talking with nothing sent is not.
        if media.get("mute"):
            bits.append("muted")
        elif sending:
            bits.append("sending audio")
        elif talking:
            bits.append("NOT sending audio while you talk")
            problems.append("audio")
        else:
            bits.append("mic quiet (nothing to send)")
        if others == 0:
            bits.append("alone in the channel")
        else:
            bits.append("receiving audio" if receiving else "no one talking")
        bits.append(f"mic level {now['mic_level']:.2f}")
        if media.get("live"):
            # Discord holds back stream video until someone watches it.
            vids = [((p.get("sent") or {}).get("video") or {}) for p in now["peers"]]
            vid = next((v for v in vids if v.get("frames")), vids[0] if vids else {})
            detail = ", ".join(x for x in (vid.get("codec", "").replace("video/", ""), vid.get("size"),
                                            f"{vid.get('fps')} fps" if vid.get("fps") is not None else "",
                                            vid.get("encoder")) if x)
            if now["video_out"] > prev["video_out"]:
                bits.append("sending video" + (f" ({detail})" if detail else ""))
            elif others == 0:
                bits.append("stream waiting for a viewer")
            else:
                bits.append("no video sent yet (sent once someone watches)" + (f" [{detail}]" if detail else ""))
        diag.set("call", diag.WARN if problems else diag.OK, "; ".join(bits))

    @classmethod
    async def _on_captcha(cls, data):
        cls.captcha = bool((data or {}).get("active"))
        try:
            await decky.emit("captcha", {"active": cls.captcha})
        except Exception:
            pass

    @classmethod
    async def get_captcha(cls):
        return {"active": cls.captcha}

    @classmethod
    async def _on_call_incoming(cls, data):
        _collect_private(data)
        cls.incoming = {**(data or {}), "received": time.time()}
        caller = (data or {}).get("caller") or {}
        log.info(f"Incoming call from {caller.get('name')}")
        try:
            await decky.emit("call", {"ringing": True, **cls.incoming})
        except Exception:
            pass

    @classmethod
    async def _on_call_ended(cls, data):
        if cls.incoming and cls.incoming.get("channel_id") == (data or {}).get("channel_id"):
            cls.incoming = None
        log.info("Call " + ("answered" if (data or {}).get("answered") else "stopped ringing"))
        try:
            await decky.emit("call", {"ringing": False, **(data or {})})
        except Exception:
            pass

    @classmethod
    def _call_popup(cls):
        """The ringing call as an overlay card that stays up until it's answered or ends."""
        c = cls.incoming
        if not c:
            return []
        if time.time() - c.get("received", 0) > 120:  # never stuck on screen
            cls.incoming = None
            return []
        caller = c.get("caller") or {}
        return [{
            "id": f"call-{c.get('channel_id')}", "kind": "call", "sticky": True,
            "name": caller.get("name") or "Someone", "avatar": caller.get("avatar"),
            "context": c.get("group") or "",
            "text": "is calling you",
            "hint": cls.call_hint,
            "age": 1.0,
        }]

    @classmethod
    async def gamepad_start(cls):
        """Start reading controller buttons for the QAM's shortcuts."""
        cls.gamepads.start()
        await asyncio.sleep(0.3)
        return cls.gamepads.info()

    @classmethod
    async def gamepad_stop(cls):
        cls.gamepads.stop()
        diag.set("controller", diag.OFF, "no shortcuts set")
        return True

    @classmethod
    async def get_gamepads(cls):
        return cls.gamepads.info()

    @classmethod
    async def set_call_hint(cls, text):
        """How to answer, from the QAM's controller shortcut settings (shown on the overlay card)."""
        cls.call_hint = str(text or "")[:120] or cls.call_hint
        return True

    @classmethod
    async def get_incoming_call(cls):
        return cls.incoming

    @classmethod
    async def answer_call(cls, channel_id=None):
        res = await cls._req("answerCall", {"channelId": channel_id or (cls.incoming or {}).get("channel_id")}, timeout=10)
        if isinstance(res, dict) and not res.get("error"):
            cls.incoming = None
        return res

    @classmethod
    async def decline_call(cls, channel_id=None):
        res = await cls._req("declineCall", {"channelId": channel_id or (cls.incoming or {}).get("channel_id")}, timeout=10)
        if isinstance(res, dict) and not res.get("error"):
            cls.incoming = None
        return res

    @classmethod
    async def _on_rtc(cls, data):
        log.info(f"Discord voice connection: {(data or {}).get('state')}")

    @classmethod
    async def _on_mic_level(cls, data):
        try:
            await decky.emit("mic_level", data)
        except Exception:
            pass

    # ------------------------------------------------------- page events

    @classmethod
    async def _on_hello(cls, data):
        cls.ready = True
        log.info(f"Discord page connected ({data.get('version')})")
        if cls.capture.port:
            await cls.bridge.push("config", {"captureUrl": f"ws://127.0.0.1:{cls.capture.port}/webrtc"})
        await cls._unlock_audio("page connected")

    _last_unlock = 0.0

    @classmethod
    async def _unlock_audio(cls, why):
        cls._last_unlock = time.monotonic()
        try:
            r = await cls.view.unlock_audio()
            if not (r or {}).get("activated"):
                log.warning(f"Discord sounds may stay blocked ({why}): the page isn't marked as interacted with")
            elif (r or {}).get("retried"):
                log.info(f"Discord sounds unlocked ({why}), replayed {r['retried']} blocked sound(s)")
        except Exception as e:
            log.warning(f"couldn't unlock Discord sounds ({why}): {e}")

    @classmethod
    async def _on_sound_blocked(cls, data):
        log.info(f"Discord sound blocked by autoplay rules: {(data or {}).get('sound')}")
        if time.monotonic() - cls._last_unlock > 2:
            await cls._unlock_audio("a sound was blocked")

    @classmethod
    async def _on_state(cls, state):
        _collect_private(state)
        cls.state = state
        user = (state or {}).get("user")
        if state and state.get("loggedIn"):
            diag.set("account", diag.OK, f"logged in as {user.get('name') if user else '?'}")
        else:
            diag.set("account", diag.WARN, "not logged in: open Discord and log in (QR code works well)")
        await cls._emit_state()

    @classmethod
    async def _on_disconnected(cls, _):
        cls.ready = False
        await cls._emit_state()

    @classmethod
    async def _emit_state(cls):
        try:
            await decky.emit("state", cls._frontend_state())
        except Exception:
            pass

    @classmethod
    async def _emit_diag(cls):
        try:
            await decky.emit("diag", None)
        except Exception:
            pass

    @classmethod
    def _frontend_state(cls):
        stage = "Ready"
        if not cls.ready:
            for key in ("steam_ui", "discord_view", "vencord", "bridge"):
                st = diag.get(key)
                if st and st["state"] != diag.OK:
                    stage = st["detail"]
                    break
            else:
                stage = "Waiting for Discord to load"
        return frontend_state(cls.state, cls.ready, stage)

    @classmethod
    async def _on_message(cls, m):
        """A DM or mention: popup in the overlay, and the QAM's Messages list."""
        _collect_private(m)
        m = m or {}
        s = cls.settings.load()
        # Do Not Disturb or muted: keep it in Recent Messages, no popup / toast.
        quiet = cls._dnd() or cls._muted_popup(m, s)
        cls.messages.add(m, popup=not quiet)
        # Steam toast only when the overlay won't show the popup.
        toast = not quiet and not (s.get("message_popups", True) and cls.overlay.active_engine(s))
        try:
            await decky.emit("message", {**(m or {}), "toast": toast, "unread": cls.messages.unread()})
        except Exception:
            pass

    @staticmethod
    def _muted_popup(m, s):
        """Whether the notification settings say no popup for this message."""
        if m.get("is_dm") and not s.get("popup_dms", True):
            return True
        if not m.get("is_dm") and not s.get("popup_mentions", True):
            return True
        if m.get("guild_id") and str(m["guild_id"]) in (s.get("muted_guilds") or {}):
            return True
        if str(m.get("channel_id")) in (s.get("muted_channels") or {}):
            return True
        return bool(s.get("popup_follow_discord", True) and m.get("discord_muted"))

    # -- stream picture-in-picture (frames from the page, for the overlay)

    pip = None

    @classmethod
    async def _on_pip_frame(cls, d):
        if not cls.pip or not isinstance(d, dict) or not d.get("data"):
            return
        if not cls.pip.get("seq"):
            diag.set("pip", diag.OK, "the stream's video is coming in")
        try:
            data = base64.b64decode(d["data"])
        except Exception:
            return
        cls.pip.update(data=data, seq=int(d.get("seq") or 0), w=d.get("w"), h=d.get("h"), at=time.time(),
                       name=d.get("name") or cls.pip.get("name"))

    @classmethod
    async def _on_pip(cls, d):
        d = d or {}
        if d.get("error"):
            diag.set("pip", diag.WARN, d["error"])
            cls.pip = None
            await cls._pretend_visible(False)
            await decky.emit("pip", {"on": False, "error": d["error"]})
        elif d.get("stopped"):
            cls.pip = None
            await cls._pretend_visible(False)
            await decky.emit("pip", {"on": False})
        elif d.get("started"):
            diag.set("pip", diag.OK, f"streaming frames to the overlay ({d.get('how')})")

    @classmethod
    def _pip_fresh(cls):
        p = cls.pip
        return bool(p and p.get("data") and time.time() - p.get("at", 0) < 3)

    @classmethod
    async def _http_pip(cls, request):
        p = cls.pip
        if not cls._pip_fresh():
            return Response(status=404)
        return Response(body=p["data"], content_type="image/jpeg",
                        headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store",
                                 "Access-Control-Expose-Headers": "X-Seq", "X-Seq": str(p.get("seq", 0))})

    @classmethod
    async def _on_mic(cls, data):
        """The page wants the mic (offer) or reports a problem: relay to the QAM side."""
        cls.mic_events.append({"time": time.time(), **{k: v for k, v in (data or {}).items() if k != "sdp"}})
        del cls.mic_events[:-10]
        if data and data.get("type") == "error":
            diag.set("mic", diag.ERROR, data.get("error", "unknown error"))
        elif data and data.get("type") == "offer":
            diag.set("mic", diag.PENDING, "Discord asked for the microphone")
        await decky.emit("mic", data)

    @classmethod
    async def _on_capture(cls, data):
        data = data or {}
        cls.capture_events.append({"time": time.time(), **data})
        del cls.capture_events[:-20]
        if data.get("type") == "error":
            diag.error("capture", f"in Discord: {data.get('error')}")
        cls.capture.wake.set()

    @classmethod
    async def _http_overlay(cls, request):
        s = cls.settings.load()
        voice = (cls.state or {}).get("voice") if cls.ready else None
        media = (cls.state or {}).get("media") or {}
        me_id = ((cls.state or {}).get("user") or {}).get("id")
        mine = next((m for m in (voice or {}).get("members", []) if m["id"] == me_id), None)
        return json_response({
            "messages": cls._call_popup() + cls.messages.active_popups(),
            "voice": voice,
            "me": {"live": bool(media.get("live")), "muted": bool(mine and mine["muted"]),
                   "deafened": bool(mine and mine["deafened"])},
            "settings": {"overlay_enabled": cls.overlay.enabled(s),
                         "overlay_position": s.get("overlay_position", "top-left"),
                         "overlay_engine_active": cls.overlay.active_engine(s),
                         "overlay_size": s.get("overlay_size", "normal"),
                         "overlay_opacity": s.get("overlay_opacity", 100),
                         "overlay_speakers_only": bool(s.get("overlay_speakers_only", False)),
                         "message_position": s.get("message_position", "top-left"),
                         "message_duration": s.get("message_duration", 8),
                         "pip_position": s.get("pip_position", "bottom-right"),
                         "pip_size": s.get("pip_size", "normal"),
                         "pip_fps": s.get("pip_fps", 30)},
            "pip": ({"seq": cls.pip.get("seq"), "w": cls.pip.get("w"), "h": cls.pip.get("h"), "name": cls.pip.get("name")}
                    if cls._pip_fresh() and not cls.pip_paused else None),
        }, headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"})

    # ------------------------------------------------------------ helpers

    @classmethod
    async def _req(cls, method, params=None, timeout=10, default=None, private=True):
        """Bridge request; returns {"error": ...} instead of raising, for the QAM."""
        try:
            res = await cls.bridge.request(method, params, timeout)
            if private:
                _collect_private(res)
            return res
        except BridgeError as e:
            if default is not None:
                return default
            return {"error": str(e)}

    # ------------------------------------------------------------ QAM API

    @classmethod
    async def get_state(cls):
        return cls._frontend_state()

    @classmethod
    async def toggle_mute(cls):
        return await cls._req("toggleMute")

    @classmethod
    async def toggle_deafen(cls):
        return await cls._req("toggleDeafen")

    @classmethod
    async def disconnect_vc(cls):
        return await cls._req("disconnect")

    @classmethod
    async def set_ptt(cls, value):
        return await cls._req("setPtt", {"down": bool(value)}, timeout=3)

    @classmethod
    async def enable_ptt(cls, enabled):
        return await cls._req("enablePtt", {"enabled": bool(enabled)})

    @classmethod
    async def get_voice_mode(cls):
        return await cls._req("voiceMode", {})

    @classmethod
    async def set_sensitivity(cls, auto, threshold=None):
        return await cls._req("setSensitivity", {"auto": bool(auto), "threshold": threshold})

    @classmethod
    async def set_rpc(cls, game):
        return await cls._req("setActivity", {"game": game}, timeout=15)

    @classmethod
    async def get_recent_channels(cls):
        res = await cls._req("recentChannels")
        return res if isinstance(res, list) else []

    @classmethod
    async def post_screenshot(cls, channel_id, data, user_id=None):
        """Send to a channel, or to a friend's DM when user_id is given."""
        b64 = data.split(",", 1)[1] if isinstance(data, str) and data.startswith("data:") else data
        params = {"data": b64, **({"userId": user_id} if user_id else {"channelId": channel_id})}
        return await cls._req("postScreenshot", params, timeout=60)

    @classmethod
    async def list_screenshots(cls, offset=0, limit=12):
        try:
            return await asyncio.to_thread(cls.screenshots.list, int(offset or 0), int(limit or 12))
        except Exception as e:
            return {"items": [], "total": 0, "error": str(e)}

    @classmethod
    async def get_screenshot(cls, shot_id):
        url = await asyncio.to_thread(cls.screenshots.data_url, shot_id)
        return {"image": url} if url else {"error": "that screenshot isn't available any more"}

    @classmethod
    async def post_screenshot_file(cls, shot_id, channel_id=None, user_id=None):
        """Send a screenshot picked from the list, to a channel or a friend's DM."""
        data, name = await asyncio.to_thread(cls.screenshots.base64, shot_id)
        if not data:
            return {"error": "that screenshot isn't available any more"}
        params = {"data": data, "filename": name, **({"userId": user_id} if user_id else {"channelId": channel_id})}
        return await cls._req("postScreenshot", params, timeout=90)

    @classmethod
    async def discord_query(cls, what, arg=None):
        method, params = {
            "guilds": ("guilds", {}),
            "voice_channels": ("voiceChannels", {"guildId": arg}),
            "text_channels": ("textChannels", {"guildId": arg}),
            "friends": ("friends", {}),
            "voice": ("voice", {}),
        }.get(what, (None, None))
        if not method:
            return {"error": f"unknown query {what}"}
        return await cls._req(method, params)

    @classmethod
    async def join_voice(cls, channel_id):
        return await cls._req("join", {"channelId": channel_id}, timeout=15)

    @classmethod
    async def call_friend(cls, user_id):
        return await cls._req("callFriend", {"userId": user_id}, timeout=20)

    @classmethod
    async def discord_nav(cls, action):
        return await cls._req("nav", {"action": action}, timeout=5, default={"handled": False})

    @classmethod
    async def get_audio_outputs(cls):
        return await cls._req("audioDevices")

    @classmethod
    async def set_audio_output(cls, device_id):
        return await cls._req("setOutput", {"id": device_id})

    @classmethod
    async def mic_answer(cls, answer):
        """The QAM side answered (or failed) the page's microphone request."""
        answer = answer or {}
        if answer.get("error"):
            diag.set("mic", diag.ERROR, answer["error"])
        else:
            diag.set("mic", diag.OK, f"connected ({answer.get('device') or 'default microphone'})")
        await cls.bridge.push("mic", answer)
        return True

    @classmethod
    async def mic_report(cls, state, detail=""):
        """Connection state changes from the QAM side of the mic bridge."""
        level = {"connected": diag.OK, "failed": diag.ERROR, "disconnected": diag.WARN}.get(state, diag.PENDING)
        diag.set("mic", level, f"{state}{': ' + detail if detail else ''}")
        return True

    # -- messages

    @classmethod
    async def get_conversations(cls):
        """Recent conversations, with Discord's own unread counts: DMs you
        haven't read yet show up even if they came in before Discordio started."""
        convs = [dict(c) for c in cls.messages.list()]
        res = await cls._req("unreads", {"channelIds": [c["channel_id"] for c in convs]}, timeout=5, default={})
        if isinstance(res, dict) and not res.get("error"):
            states = res.get("channels") or {}
            for c in convs:
                st = states.get(c["channel_id"])
                if st is not None:
                    c["unread"] = st.get("unread", 0) if st.get("has") else 0
                    c["mentions"] = st.get("mentions", 0)
            have = {c["channel_id"] for c in convs}
            for d in res.get("dms") or []:
                if d.get("channel_id") not in have:
                    d = dict(d)
                    d["updated"] = (d.get("last") or {}).get("time") or 0
                    convs.append(d)
            convs.sort(key=lambda c: (c.get("unread", 0) > 0, c.get("updated") or 0), reverse=True)
        mutes = cls.settings.load().get("muted_channels") or {}
        for c in convs:
            c["popups_muted"] = c["channel_id"] in mutes
        total = sum(c.get("unread", 0) for c in convs if not c.get("muted"))
        return {"conversations": convs, "unread": total}

    @classmethod
    async def get_profile(cls, user_id=None):
        return await cls._req("profile", {"userId": user_id}, timeout=15)

    @classmethod
    async def get_badges(cls):
        res = await cls._req("badges", {}, timeout=15, private=False)
        if isinstance(res, dict) and res.get("badges") is not None:
            # In the log (and reports), to see what Discord sends for each badge.
            log.info("Badges: " + ", ".join(f"{b.get('id')}: {b.get('description')}" for b in res["badges"]))
        return res

    @classmethod
    async def edit_message(cls, channel_id, message_id, content):
        return await cls._req("editMessage", {"channelId": channel_id, "messageId": message_id, "content": content}, timeout=15)

    @classmethod
    async def delete_message(cls, channel_id, message_id):
        return await cls._req("deleteMessage", {"channelId": channel_id, "messageId": message_id}, timeout=15)

    @classmethod
    async def get_friend_requests(cls):
        return await cls._req("friendRequests", {})

    @classmethod
    async def friend_request(cls, action, user_id=None, username=None):
        """accept / decline (incoming), cancel (outgoing), send (by username)."""
        return await cls._req("friendRequest", {"action": action, "userId": user_id, "username": username}, timeout=15)

    @classmethod
    async def show_notice(cls, title, text):
        """A popup where message popups appear. False if the overlay can't show
        it right now (the QAM shows a Steam toast instead)."""
        s = cls.settings.load()
        if not (s.get("message_popups", True) and cls.overlay and cls.overlay.active_engine(s)):
            return False
        cls.messages.notice(title, text, hint="Discordio")
        return True

    @classmethod
    async def get_unread_total(cls):
        res = await cls._req("unreads", {"channelIds": [c["channel_id"] for c in cls.messages.list()]}, timeout=5, default={})
        if not isinstance(res, dict) or res.get("error"):
            return cls.messages.unread()
        total = res.get("total", 0)
        dm_ids = {d.get("channel_id") for d in res.get("dms") or []}
        for cid, st in (res.get("channels") or {}).items():
            if cid not in dm_ids and st.get("has"):
                total += max(1, st.get("mentions", 0))
        return total

    @classmethod
    async def mark_read(cls, channel_ids=None, guild_id=None):
        """Mark conversations, or a whole server, as read in Discord."""
        ids = [c for c in (channel_ids or []) if c]
        for c in ids:
            cls.messages.mark_read(c)
        return await cls._req("ack", {"channelIds": ids, "guildId": guild_id}, timeout=15)

    @classmethod
    async def mark_all_read(cls):
        res = await cls._req("unreads", {"channelIds": [c["channel_id"] for c in cls.messages.list()]}, timeout=5, default={})
        ids = [c["channel_id"] for c in cls.messages.list()]
        if isinstance(res, dict):
            ids += [d.get("channel_id") for d in res.get("dms") or []]
        return await cls.mark_read(list(dict.fromkeys(ids)))

    @classmethod
    async def set_popup_mute(cls, kind, id, name=None, muted=True):
        """No popups from a server ("guild") or a channel / DM ("channel")."""
        key = "muted_guilds" if kind == "guild" else "muted_channels"
        s = cls.settings.load()
        cur = dict(s.get(key) or {})
        if muted:
            cur[str(id)] = name or str(id)
        else:
            cur.pop(str(id), None)
        cls.settings.update(**{key: cur})
        return await cls.get_message_settings()

    @classmethod
    async def get_history(cls, channel_id):
        cls.messages.mark_read(channel_id)
        return await cls._req("history", {"channelId": channel_id, "limit": 30}, timeout=15)

    # -- people in your call

    @classmethod
    async def set_local_mute(cls, user_id, muted):
        """Mute someone for you only (they don't know)."""
        return await cls._req("setLocalMute", {"userId": user_id, "muted": bool(muted)})

    @classmethod
    async def set_user_volume(cls, user_id, volume):
        """Someone's volume for you only, 0 to 200 (%)."""
        return await cls._req("setUserVolume", {"userId": user_id, "volume": volume})

    @classmethod
    async def moderate(cls, user_id, action, value=None):
        """Server mute / deafen / disconnect someone (needs the permission)."""
        res = await cls._req("moderate", {"userId": user_id, "action": action, "value": value}, timeout=15)
        log.info(f"Moderation {action}={value} on {user_id}: {res}")
        return res

    # -- account

    @classmethod
    async def get_accounts(cls):
        return await cls._req("accounts")

    @classmethod
    async def switch_account(cls, user_id):
        log.info("Switching Discord account")
        return await cls._req("switchAccount", {"userId": user_id}, timeout=20)

    @classmethod
    async def logout(cls):
        log.info("Logging out of Discord")
        return await cls._req("logout", timeout=15)

    @classmethod
    async def get_gifs(cls, query=None):
        return await cls._req("gifs", {"query": (query or "").strip() or None}, timeout=15, private=False)

    @classmethod
    async def get_emojis(cls, channel_id=None):
        # Emoji names aren't private, and there can be thousands: keep them
        # out of the diagnostics name list (only server names are collected).
        res = await cls._req("emojis", {"channelId": channel_id}, timeout=15, private=False)
        if isinstance(res, dict):
            for s in res.get("servers") or []:
                if isinstance(s, dict) and isinstance(s.get("name"), str):
                    diag.remember_private(s["name"])
        return res

    @classmethod
    async def react(cls, channel_id, message_id, emoji, remove=False):
        return await cls._req("react", {"channelId": channel_id, "messageId": message_id, "emoji": emoji,
                                        "remove": bool(remove)}, timeout=10)

    @classmethod
    async def watch_stream(cls, user_id, overlay=False, player=False):
        """Watch someone's Go Live (joins their voice channel if needed):
        full screen in the Discord view, or as a picture-in-picture in the
        in-game overlay while you keep playing."""
        fps = cls.settings.load().get("pip_fps", 30)
        if player and cls.pip:
            # Full screen over the corner picture: hide the corner one until
            # you're back (end_full_screen), same stream either way.
            cls.pip_paused = True
        if overlay:
            # Like Go Live: Discord only receives a stream's video while it
            # thinks the stream is on screen, so the hidden page has to look
            # visible (one pixel, full size by emulation).
            await cls._pretend_visible(True)
        res = await cls._req("watchStream", {"userId": user_id, "overlay": bool(overlay), "fps": fps,
                                             "player": bool(player)}, timeout=15)
        if overlay and isinstance(res, dict) and not res.get("error"):
            cls.pip = {"on": True, "starting": time.time(), "seq": 0, "data": None, "name": res.get("name"),
                       "user_id": user_id}
            cls.pip_paused = False
            diag.set("pip", diag.PENDING, "waiting for the stream's video")
        elif overlay:
            await cls._pretend_visible(False)
        return res

    pretending = False

    @classmethod
    async def _pretend_visible(cls, on):
        if bool(on) == cls.pretending or not cls.view:
            return
        cls.pretending = bool(on)
        try:
            await cls.view.emulate_full_size(on)
            await cls.view.stealth_visible(on)
        except Exception as e:
            log.warning(f"stream view visibility ({on}): {e}")

    @classmethod
    async def stop_watching(cls):
        cls.pip = None
        cls.pip_paused = False
        res = await cls._req("stopWatching", {}, timeout=10)
        await cls._pretend_visible(False)
        return res

    pip_paused = False

    @classmethod
    async def end_full_screen(cls):
        """B in the full-screen player: back to the corner picture if one was
        showing, otherwise stop watching."""
        if cls.pip:
            cls.pip_paused = False
            return await cls._req("hidePlayer", {}, timeout=10)
        return await cls.stop_watching()

    @classmethod
    async def _on_watch_ended(cls, _d):
        was = cls.pip
        cls.pip = None
        await cls._pretend_visible(False)
        await decky.emit("pip", {"on": False, "ended": True, "name": (was or {}).get("name")})

    @classmethod
    async def get_pip(cls):
        p = cls.pip
        if not p:
            return {"on": False}
        return {"on": True, "name": p.get("name"), "user_id": p.get("user_id"), "frames": p.get("seq", 0),
                "live": cls._pip_fresh()}

    @classmethod
    async def set_pip_look(cls, position=None, size=None, fps=None):
        changes = {}
        try:
            if fps is not None and int(fps) in PIP_FPS:
                changes["pip_fps"] = int(fps)
                if cls.pip:
                    await cls._req("pipFps", {"fps": int(fps)})
        except (TypeError, ValueError):
            pass
        if position in OVERLAY_POSITIONS:
            changes["pip_position"] = position
        if size in ("small", "normal", "large"):
            changes["pip_size"] = size
        if changes:
            cls.settings.update(**changes)
        s = cls.settings.load()
        return {"position": s.get("pip_position", "bottom-right"), "size": s.get("pip_size", "normal"),
                "fps": s.get("pip_fps", 30)}

    # -- status

    @classmethod
    async def set_status(cls, status=None, custom=None, emoji=None, clear_after=None):
        """Online / idle / dnd / invisible, and / or a custom status: text ("" clears it),
        emoji ({id, name} / {name} / "none"), clear after (minutes, "today", or 0 = never)."""
        return await cls._req("setStatus", {"status": status, "custom": custom, "emoji": emoji,
                                            "clearAfter": clear_after}, timeout=15)

    # -- Discord page resource use

    usage_samples = []      # (time, cpu %, js MB), last 10 minutes

    @classmethod
    async def _usage_loop(cls):
        while True:
            await asyncio.sleep(10)
            try:
                if not cls.view or not cls.ready:
                    continue
                u = await cls.view.usage()
                if u.get("cpu") is not None:
                    cls.usage_samples.append((time.time(), u["cpu"], u["js_mb"]))
                    cutoff = time.time() - 600
                    cls.usage_samples = [x for x in cls.usage_samples if x[0] >= cutoff]
                cpus = [x[1] for x in cls.usage_samples]
                if cpus:
                    diag.set("page_usage", diag.OK,
                             f"CPU avg {sum(cpus) / len(cpus):.1f}% (peak {max(cpus):.0f}%), JS memory {u['js_mb']} MB")
            except asyncio.CancelledError:
                raise
            except Exception as e:
                diag.set("page_usage", diag.WARN, f"couldn't measure: {e}")

    @classmethod
    async def get_page_usage(cls):
        try:
            now = await cls.view.usage() if cls.view and cls.ready else None
        except Exception as e:
            return {"error": str(e)}
        cpus = [x[1] for x in cls.usage_samples]
        mems = [x[2] for x in cls.usage_samples]
        return {
            "now": now,
            "avg_cpu": round(sum(cpus) / len(cpus), 1) if cpus else None,
            "peak_cpu": round(max(cpus), 1) if cpus else None,
            "peak_js_mb": max(mems) if mems else None,
            "minutes": round((cls.usage_samples[-1][0] - cls.usage_samples[0][0]) / 60, 1) if len(cpus) > 1 else 0,
        }

    @classmethod
    def _dnd(cls):
        return ((cls.state or {}).get("status") or {}).get("status") == "dnd"

    @classmethod
    async def open_dm(cls, user_id):
        """The DM channel with a friend (created if there's none yet)."""
        return await cls._req("openDm", {"userId": user_id}, timeout=15)

    @classmethod
    async def call_channel(cls, channel_id):
        """Start a call in a DM / group DM and ring the others."""
        return await cls._req("callChannel", {"channelId": channel_id}, timeout=15)

    @classmethod
    async def send_message(cls, channel_id, content, reply_to=None):
        res = await cls._req("sendMessage", {"channelId": channel_id, "content": content, "replyTo": reply_to}, timeout=15)
        if isinstance(res, dict) and not res.get("error"):
            cls.messages.mark_read(channel_id)
        return res

    @classmethod
    async def get_message_settings(cls):
        s = cls.settings.load()
        return {"popups": s.get("message_popups", True), "position": s.get("message_position", "top-left"),
                "duration": s.get("message_duration", 8), "dms": s.get("popup_dms", True),
                "mentions": s.get("popup_mentions", True), "follow_discord": s.get("popup_follow_discord", True),
                "muted_guilds": s.get("muted_guilds") or {}, "muted_channels": s.get("muted_channels") or {}}

    @classmethod
    async def set_message_settings(cls, popups=None, position=None, duration=None, dms=None, mentions=None,
                                   follow_discord=None):
        changes = {}
        for key, v in (("popup_dms", dms), ("popup_mentions", mentions), ("popup_follow_discord", follow_discord)):
            if v is not None:
                changes[key] = bool(v)
        if popups is not None:
            changes["message_popups"] = bool(popups)
        if position in OVERLAY_POSITIONS:
            changes["message_position"] = position
        try:
            if duration is not None and int(duration) in MESSAGE_DURATIONS:
                changes["message_duration"] = int(duration)
        except (TypeError, ValueError):
            pass
        if changes:
            cls.settings.update(**changes)
        return await cls.get_message_settings()

    # -- streaming

    @classmethod
    async def get_stream_settings(cls):
        s = cls.settings.load()
        return {"resolution": s["stream_resolution"], "fps": s["stream_fps"]}

    @classmethod
    async def apply_nitro_default(cls):
        """With Nitro: start from 1080p 60, once, unless you already picked a quality."""
        s = cls.settings.load()
        if s.get("quality_chosen") or s.get("nitro_default_applied"):
            return None
        cls.settings.update(stream_resolution="1080", stream_fps=60, nitro_default_applied=True)
        log.info("Nitro: stream quality defaulted to 1080p 60")
        return await cls.get_stream_settings()

    @classmethod
    async def set_stream_settings(cls, resolution=None, fps=None):
        changes = {"quality_chosen": True}
        if resolution is not None and str(resolution) in RESOLUTIONS:
            changes["stream_resolution"] = str(resolution)
        try:
            if fps is not None and int(fps) in FRAME_RATES:
                changes["stream_fps"] = int(fps)
        except (TypeError, ValueError):
            pass
        if changes:
            cls.settings.update(**changes)
        return await cls.get_stream_settings()

    @classmethod
    async def get_stream_limits(cls):
        return await cls._req("streamLimits")

    @classmethod
    async def get_stream_preview(cls):
        return await cls.capture.preview()

    @classmethod
    async def go_live(cls):
        if not cls.capture.running:
            return {"ok": False, "error": "the capture helper isn't running yet (see Diagnostics)"}
        started = time.time()
        quality = await cls.get_stream_settings()
        # Discord's own Share Screen button, pressed in the hidden view. The
        # view is never shown on screen (that could expose your DMs).
        # 1. Hidden, with the page laid out at full size (DevTools emulation).
        stealth = False
        try:
            try:
                await cls.view.emulate_full_size(True)
                await asyncio.sleep(0.4)
            except Exception as e:
                log.warning(f"Go Live: full-size emulation unavailable: {e}")
            res = await cls._req("goLive", {"quality": quality, "uiOnly": True}, timeout=25)
            if isinstance(res, dict) and "NO_SHARE_BUTTON" in str(res.get("error", "")):
                # 2. "Visible" to the page but only 1x1 pixel on screen.
                vis = await cls._req("pageVisible", timeout=5)
                if isinstance(vis, dict) and not vis.get("visible"):
                    stealth = bool(await cls.view.stealth_visible(True))
                    log.info("Go Live: rendering the Discord view off-screen (1x1) to reach Share Screen")
                    await asyncio.sleep(1.0)
                res = await cls._req("goLive", {"quality": quality, "uiOnly": True}, timeout=25)
        finally:
            if stealth:
                for attempt in range(3):
                    try:
                        await cls.view.stealth_visible(False)
                        await asyncio.sleep(0.3)
                        vis = await cls._req("pageVisible", timeout=5)
                        if not (isinstance(vis, dict) and vis.get("visible")):
                            break
                        log.warning("Go Live: the Discord view still reports visible, hiding again")
                    except Exception as e:
                        log.warning(f"Go Live: couldn't hide the Discord view again: {e}")
            try:
                await cls.view.emulate_full_size(False)
            except Exception:
                pass
        if isinstance(res, dict) and "NO_SHARE_BUTTON" in str(res.get("error", "")):
            # 3. Last resort: Discord's stream function plus a stream source.
            res = await cls._req("goLive", {"quality": quality}, timeout=35)
        if isinstance(res, dict) and res.get("error"):
            return {"ok": False, "error": res["error"]}
        method = res.get("method") if isinstance(res, dict) else None
        # Discord starts the stream, then asks for the capture: watch for either
        # the capture failing or the stream actually going live.
        for _ in range(24):
            await asyncio.sleep(0.5)
            err = next((e for e in reversed(cls.capture_events) if e["time"] >= started and e.get("type") == "error"), None)
            if err:
                return {"ok": False, "error": f"Screen capture failed: {err.get('error')}"}
            if any(e["time"] >= started and e.get("type") == "started" for e in cls.capture_events):
                return {"ok": True, "method": method}
        return {"ok": True, "method": method,
                "warning": "Discord started the stream, but the capture hasn't confirmed yet; check the preview"}

    @classmethod
    async def stop_go_live(cls):
        res = await cls._req("stopLive", timeout=10)
        if isinstance(res, dict) and res.get("error"):
            return {"ok": False, "error": res["error"]}
        return {"ok": True, "method": res.get("method") if isinstance(res, dict) else None}

    @classmethod
    async def get_capture_log(cls):
        lines = cls.capture.lines[-12:]
        if not cls.settings.load().get("diag_show_private"):
            lines = [diag.redact_text(l) for l in lines]
        return {"running": cls.capture.running, "lines": lines}

    @classmethod
    async def restart_capture(cls):
        cls.capture.restart()
        return True

    @classmethod
    async def reset_capture_method(cls):
        cls.capture.reset_method()
        return True

    # -- overlay

    @classmethod
    async def get_overlay_settings(cls):
        return cls.overlay.info()

    @classmethod
    async def set_overlay_hide_perf(cls, on):
        cls.settings.update(overlay_hide_perf=bool(on))
        return cls.overlay.info()

    @classmethod
    async def get_perf_hold(cls):
        """Whether the performance overlay should be off right now (a call)."""
        return bool(cls.overlay and cls.overlay.hold)

    @classmethod
    async def perf_hold_log(cls, ok, detail):
        diag.set("perf_hold", diag.OK if ok else diag.WARN, str(detail)[:200])

    @classmethod
    async def set_overlay_look(cls, size=None, opacity=None, speakers_only=None):
        """Overlay size (small / normal / large), opacity (30-100 %), only show who's talking."""
        changes = {}
        if size in ("small", "normal", "large"):
            changes["overlay_size"] = size
        if opacity is not None:
            try:
                changes["overlay_opacity"] = max(30, min(100, int(opacity)))
            except (TypeError, ValueError):
                pass
        if speakers_only is not None:
            changes["overlay_speakers_only"] = bool(speakers_only)
        if changes:
            cls.settings.update(**changes)
        return cls.overlay.info()

    @classmethod
    async def set_overlay_settings(cls, enabled=None, position=None, engine=None, calls=None):
        changes = {}
        if calls is not None:
            changes["overlay_calls"] = bool(calls)
        if enabled is not None:
            changes["overlay_enabled"] = bool(enabled)
        if position in OVERLAY_POSITIONS:
            changes["overlay_position"] = position
        if engine in OVERLAY_ENGINES:
            changes["overlay_engine"] = engine
        if changes:
            cls.settings.update(**changes)
        return cls.overlay.info()

    # -- updates

    @classmethod
    async def get_update_info(cls):
        return await updates.check(VERSION, cls.settings.load().get("update_channel", "stable"))

    @classmethod
    async def set_update_channel(cls, channel):
        cls.settings.update(update_channel="beta" if channel == "beta" else "stable")
        return await cls.get_update_info()

    # -- view

    @classmethod
    async def mic_test(cls, seconds=6, loopback=False):
        """Measure the microphone as Discord would get it, optionally hearing yourself."""
        await cls._unlock_audio("mic test")
        try:
            r = await cls.bridge.request("micTest", {"seconds": int(seconds), "loopback": bool(loopback)},
                                         timeout=int(seconds) + 25)
            log.info(f"Mic test: {r}")
            return r
        except Exception as e:
            log.warning(f"Mic test failed: {e}")
            return {"error": str(e)}

    @classmethod
    async def get_call_health(cls):
        return diag.get("call") or {"state": "off", "detail": "not in a call"}

    @classmethod
    async def get_call_stats(cls):
        try:
            return cls._call_summary(await cls.bridge.request("rtcStats", timeout=5))
        except Exception as e:
            return {"error": str(e)}

    @classmethod
    async def test_sound(cls):
        """Play a Discord sound in the view, to check that you can hear its ringing and alerts."""
        await cls._unlock_audio("test sound")
        try:
            return await cls.bridge.request("testSound", timeout=8)
        except Exception as e:
            return {"error": str(e)}

    @classmethod
    async def restart_discord(cls):
        cls.ready = False
        cls.view.restart()
        return True

    # ------------------------------------------------------- diagnostics

    @classmethod
    async def get_diagnostics(cls):
        snap = diag.snapshot()
        snap.update({
            "version": VERSION,
            "bridge": cls.bridge.info(),
            "capture": {"running": cls.capture.running, "port": cls.capture.port,
                        "status": cls.capture.status, "last_exit": cls.capture.last_exit,
                        "events": cls.capture_events[-5:]},
            "overlay": cls.overlay.info(),
            "mic_events": cls.mic_events[-5:],
            "show_private": bool(cls.settings.load().get("diag_show_private")),
        })
        return snap if snap["show_private"] else diag.redact(snap)

    @classmethod
    async def get_system_info(cls):
        info = await asyncio.get_running_loop().run_in_executor(None, _system_info)
        info["discordio_update_channel"] = cls.settings.load().get("update_channel", "stable")
        return info

    @classmethod
    async def set_diag_privacy(cls, show_private):
        """Show real names / IDs in Diagnostics and reports (off by default)."""
        cls.settings.update(diag_show_private=bool(show_private))
        return bool(show_private)

    @classmethod
    async def run_self_test(cls):
        """Checks each part in turn and says exactly which step fails."""
        results = []

        async def check(name, coro):
            started = time.monotonic()
            try:
                detail = await coro
                results.append({"name": name, "ok": True, "detail": detail or "ok",
                                "ms": round((time.monotonic() - started) * 1000)})
            except Exception as e:
                results.append({"name": name, "ok": False, "detail": str(e) or type(e).__name__,
                                "ms": round((time.monotonic() - started) * 1000)})

        async def steam_ui():
            from discordio import cdp
            targets = await cdp.list_targets()
            return f"{len(targets)} Steam UI pages"

        async def view():
            if not cls.view.target or not cls.view.target.connected:
                raise RuntimeError("the Discord view isn't connected")
            return "connected"

        async def bridge():
            r = await cls.bridge.request("ping", timeout=5)
            if not r.get("ready"):
                raise RuntimeError("the page answered but Discord hasn't finished loading")
            return f"answered in {cls.bridge.stats['latency_ms']} ms"

        async def internals():
            r = await cls.bridge.request("selfTest", timeout=5)
            missing = [k for k, v in r.items() if not v]
            if missing:
                raise RuntimeError("not available: " + ", ".join(missing))
            return "all Discord internals found"

        async def mic():
            r = await cls.bridge.request("micStatus", timeout=5)
            if r.get("lastError"):
                raise RuntimeError(r["lastError"])
            return f"connection: {r.get('connection')}"

        async def mic_level():
            r = await cls.bridge.request("micTest", {"seconds": 3, "loopback": False}, timeout=30)
            if r.get("verdict") == "silent":
                raise RuntimeError(f"Discord hears silence from the microphone (peak {r.get('peak')}); "
                                   "talk during the test, or check the input in Settings")
            return f"peak {r.get('peak')}, {r.get('verdict')}"

        async def sounds():
            await cls._unlock_audio("self-test")
            r = await cls.bridge.request("soundStatus", timeout=5)
            if not r.get("activated"):
                raise RuntimeError("Chromium is blocking sound in the Discord view (no user interaction)")
            if r.get("blocked") and r.get("last"):
                return f"allowed now; {r['blocked']} blocked earlier (last: {r['last']})"
            return f"allowed, {r.get('played', 0)} played"

        async def capture():
            await cls.capture.refresh()
            st = cls.capture.status
            if not st:
                raise RuntimeError("the capture helper isn't answering")
            if st.get("missing_elements"):
                raise RuntimeError("GStreamer missing: " + ", ".join(st["missing_elements"]))
            if not st.get("node"):
                raise RuntimeError("gamescope's video feed isn't in PipeWire")
            return f"gamescope node {st['node']['id']}, method {st.get('method') or 'not chosen yet'}"

        async def preview():
            for _ in range(10):
                r = await cls.capture.preview()
                if r.get("image"):
                    return f"got a frame ({len(r['image']) // 1024} KB)"
                if r.get("error"):
                    raise RuntimeError(r["error"])
                await asyncio.sleep(3)  # still searching for a capture method
            raise RuntimeError("still searching for a capture method after 30s")

        await check("Steam UI", steam_ui())
        await check("Discord view", view())
        await check("Bridge", bridge())
        await check("Discord internals", internals())
        await check("Microphone bridge", mic())
        await check("Discord sounds", sounds())
        await check("Microphone level", mic_level())
        await check("Capture helper", capture())
        await check("Capture preview", preview())
        log.info("Self-test: " + "; ".join(f"{r['name']} {'ok' if r['ok'] else 'FAILED: ' + r['detail']}" for r in results))
        return results

    @classmethod
    async def export_report(cls, frontend=None):
        """Write everything useful for debugging to a text file in the user's home."""
        _, _, home = system.session_user(decky)
        path = Path(home) / "discordio-report.txt"
        d = await cls.get_diagnostics()
        lines = [
            f"Discordio report  {time.strftime('%Y-%m-%d %H:%M:%S')}",
            f"version {VERSION}, Python {platform.python_version()}, Decky {getattr(decky, 'DECKY_VERSION', '?')}",
            f"OS: {_os_release()}",
            "",
            "== System",
        ]
        sysinfo = _system_info()
        sysinfo["discordio_update_channel"] = cls.settings.load().get("update_channel", "stable")
        steam = (frontend or {}).pop("steam", None) if isinstance(frontend, dict) else None
        if isinstance(steam, dict):
            sysinfo.update({f"steam_{k}": v for k, v in steam.items()})
        lines += [f"  {k}: {v}" for k, v in sysinfo.items()]
        lines += ["", "== Health"]
        for c in d["components"]:
            lines.append(f"  [{c['state']:7}] {c['label']}: {c['detail']}")
        lines += ["", "== Recent errors"]
        lines += [f"  {time.strftime('%H:%M:%S', time.localtime(e['time']))} {e['component']}: {e['message']}"
                  for e in d["errors"]] or ["  none"]
        lines += ["", "== Bridge", "  " + json.dumps(d["bridge"])]
        lines += ["", "== Capture", "  " + json.dumps(d["capture"], default=str)]
        lines += ["", "== Overlay", "  " + json.dumps(d["overlay"])]
        lines += ["", "== Controllers", "  " + json.dumps(cls.gamepads.info() if cls.gamepads else None)]
        lines += ["", "== Mic events", "  " + json.dumps(d["mic_events"])]
        for title, method in (("Call connections", "rtcStats"), ("Go Live capture (page)", "captureStatus"),
                              ("Sounds", "soundStatus"), ("Microphone (page)", "micStatus")):
            try:
                value = await cls.bridge.request(method, timeout=5)
            except Exception as e:
                value = {"error": str(e)}
            lines += ["", f"== {title}", "  " + json.dumps(value, default=str)]
        if frontend:
            lines += ["", "== QAM side", "  " + json.dumps(frontend, default=str)]
        lines += ["", "== Settings", "  " + json.dumps(cls.settings.load())]
        lines += ["", "== Log (newest last)"] + ["  " + l for l in diag.log_lines(300)]
        text = "\n".join(lines) + "\n"
        if not d.get("show_private"):
            text = ("Names and Discord IDs are hidden (<name>, <id>). Turn on \"Show names in diagnostics\"\n"
                    "in Discordio's Diagnostics to include them.\n\n" + diag.redact_text(text))
        path.write_text(text)
        try:
            uid = system.session_user(decky)[1]
            os.chown(path, uid, uid)
        except Exception:
            pass
        log.info(f"Report written to {path}")
        return str(path)


def _run(cmd, timeout=3):
    import subprocess
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return (out.stdout or out.stderr or "").strip()
    except Exception:
        return ""


BRANCH_NAMES = {"rel": "Stable", "stable": "Stable", "rc": "Release Candidate", "beta": "Beta",
                "bc": "Beta Candidate", "main": "Main (preview)", "staging": "Staging"}


def _system_info():
    """What a bug report needs to know about the machine (no personal data)."""
    info = {}
    try:
        rel = dict(l.split("=", 1) for l in Path("/etc/os-release").read_text().splitlines() if "=" in l)
        rel = {k: v.strip().strip('"') for k, v in rel.items()}
        info["os"] = rel.get("PRETTY_NAME") or rel.get("NAME") or "?"
        info["os_version"] = rel.get("VERSION_ID") or "?"
        info["os_build"] = rel.get("BUILD_ID") or "?"
        if rel.get("VARIANT_ID"):
            info["os_variant"] = rel["VARIANT_ID"]
    except Exception:
        info["os"] = platform.platform()
    branch = _run(["steamos-select-branch", "-c"]).splitlines()
    branch = branch[-1].strip() if branch else ""
    if not branch:
        for f in ("/etc/steamos-branch", "/var/lib/steamos-branch"):
            try:
                branch = Path(f).read_text().strip()
                break
            except Exception:
                pass
    info["steamos_channel"] = BRANCH_NAMES.get(branch.lower(), branch) if branch else "unknown"
    try:
        _, _, home = system.session_user(decky)
        beta = Path(home) / ".local/share/Steam/package/beta"
        info["steam_client_channel"] = f"Beta ({beta.read_text().strip()})" if beta.exists() and beta.read_text().strip() else "Stable"
    except Exception:
        info["steam_client_channel"] = "unknown"
    info["kernel"] = platform.release()
    try:
        vendor = Path("/sys/class/dmi/id/sys_vendor").read_text().strip()
        product = Path("/sys/class/dmi/id/product_name").read_text().strip()
        info["hardware"] = f"{vendor} {product}".strip()
    except Exception:
        pass
    gs = _run(["gamescope", "--version"], timeout=2).splitlines()
    if gs:
        info["gamescope"] = gs[0][:80]
    info["decky"] = str(getattr(decky, "DECKY_VERSION", "?"))
    info["discordio"] = VERSION
    info["python"] = platform.python_version()
    return info


def _os_release():
    try:
        info = dict(l.split("=", 1) for l in Path("/etc/os-release").read_text().splitlines() if "=" in l)
        return f"{info.get('PRETTY_NAME', '').strip(chr(34))} build {info.get('BUILD_ID', '?').strip(chr(34))}"
    except Exception:
        return platform.platform()
