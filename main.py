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
            "avatar": user.get("avatar"),
            "is_muted": bool(media.get("mute")),
            "is_deafened": bool(media.get("deaf")),
            "is_live": bool(media.get("live")),
        },
        "vc": ({"channel_name": voice["channel_name"], "guild_name": voice["guild_name"], "users": voice["members"]}
               if voice else {}),
        "voice": voice,
        "stage": stage,
        "error": None,
        "attempts": 0,
    }


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
        cls.bridge.on("call_incoming", cls._on_call_incoming)
        cls.bridge.on("call_ended", cls._on_call_ended)
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
            get("/health", lambda r: json_response({"ok": True, "version": VERSION})),
        ])
        cls.runner = AppRunner(app, access_log=None)
        await cls.runner.setup()
        await TCPSite(cls.runner, "127.0.0.1", cls.port).start()
        log.info(f"Local server on 127.0.0.1:{cls.port}")

        cls.capture = CaptureManager(decky, PLUGIN_DIR, RUNTIME_DIR, cls.settings, log)
        cls.overlay = OverlayManager(decky, PLUGIN_DIR, RUNTIME_DIR, cls.settings,
                                     f"http://127.0.0.1:{cls.port}/overlay", log)
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
    async def _on_call_incoming(cls, data):
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
        cls.messages.add(m or {})
        s = cls.settings.load()
        # Steam toast only when the overlay won't show the popup.
        toast = not (s.get("message_popups", True) and cls.overlay.active_engine(s))
        try:
            await decky.emit("message", {**(m or {}), "toast": toast, "unread": cls.messages.unread()})
        except Exception:
            pass

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
            "settings": {"overlay_enabled": s.get("overlay_enabled", True),
                         "overlay_position": s.get("overlay_position", "top-left"),
                         "overlay_engine_active": cls.overlay.active_engine(s),
                         "message_position": s.get("message_position", "top-left"),
                         "message_duration": s.get("message_duration", 8)},
        }, headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"})

    # ------------------------------------------------------------ helpers

    @classmethod
    async def _req(cls, method, params=None, timeout=10, default=None):
        """Bridge request; returns {"error": ...} instead of raising, for the QAM."""
        try:
            return await cls.bridge.request(method, params, timeout)
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
        return {"conversations": cls.messages.list(), "unread": cls.messages.unread()}

    @classmethod
    async def get_history(cls, channel_id):
        cls.messages.mark_read(channel_id)
        return await cls._req("history", {"channelId": channel_id, "limit": 30}, timeout=15)

    @classmethod
    async def open_dm(cls, user_id):
        """The DM channel with a friend (created if there's none yet)."""
        return await cls._req("openDm", {"userId": user_id}, timeout=15)

    @classmethod
    async def call_channel(cls, channel_id):
        """Start a call in a DM / group DM and ring the others."""
        return await cls._req("callChannel", {"channelId": channel_id}, timeout=15)

    @classmethod
    async def send_message(cls, channel_id, content):
        res = await cls._req("sendMessage", {"channelId": channel_id, "content": content}, timeout=15)
        if isinstance(res, dict) and not res.get("error"):
            cls.messages.mark_read(channel_id)
        return res

    @classmethod
    async def get_message_settings(cls):
        s = cls.settings.load()
        return {"popups": s.get("message_popups", True), "position": s.get("message_position", "top-left"),
                "duration": s.get("message_duration", 8)}

    @classmethod
    async def set_message_settings(cls, popups=None, position=None, duration=None):
        changes = {}
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
    async def set_stream_settings(cls, resolution=None, fps=None):
        changes = {}
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
        return {"running": cls.capture.running, "lines": cls.capture.lines[-12:]}

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
    async def set_overlay_settings(cls, enabled=None, position=None, engine=None):
        changes = {}
        if enabled is not None:
            changes["overlay_enabled"] = bool(enabled)
        if position in OVERLAY_POSITIONS:
            changes["overlay_position"] = position
        if engine in OVERLAY_ENGINES:
            changes["overlay_engine"] = engine
        if changes:
            cls.settings.update(**changes)
        if enabled is False:
            await cls.overlay.stop()
        return cls.overlay.info()

    # -- updates

    @classmethod
    async def get_update_info(cls):
        return await updates.check(VERSION)

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
        })
        return snap

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
            "== Health",
        ]
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
        path.write_text("\n".join(lines) + "\n")
        try:
            uid = system.session_user(decky)[1]
            os.chown(path, uid, uid)
        except Exception:
            pass
        log.info(f"Report written to {path}")
        return str(path)


def _os_release():
    try:
        info = dict(l.split("=", 1) for l in Path("/etc/os-release").read_text().splitlines() if "=" in l)
        return f"{info.get('PRETTY_NAME', '').strip(chr(34))} build {info.get('BUILD_ID', '?').strip(chr(34))}"
    except Exception:
        return platform.platform()
