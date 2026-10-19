"""
Discordio capture helper.

A small local server that turns gamescope's screen feed (PipeWire) plus the
game's audio into a WebRTC stream for Discord's Go Live, and serves preview
snapshots of exactly that feed.

  GET  /status    JSON health: node found, method in use, frames flowing, errors
  GET  /preview   one JPEG frame (202 + text while still finding a method)
  WS   /webrtc    stream session: page sends an offer, gets an answer + ICE

Which PipeWire settings deliver frames depends on the PipeWire / GStreamer
versions on the machine, so the helper tries a few methods, each in a child
process that is killed if it hangs, and remembers the first that works.

Started by the plugin backend; exits when the backend goes away.
"""

import asyncio
import ctypes
import json
import logging
import os
import signal
import subprocess
import sys
import tempfile
import time

import gi

gi.require_version("Gst", "1.0")
from gi.repository import Gst  # noqa: E402

PORT = int(os.environ.get("DISCORDIO_CAPTURE_PORT", "65124"))
SETTINGS = os.environ.get("DISCORDIO_SETTINGS", "")
MY_LIBS = os.environ.get("DISCORDIO_LIBS", "system")
TEST_SOURCE = os.environ.get("DISCORDIO_TEST_SRC")
VARIANTS = ["target+raw", "path+raw", "target", "path"]
EXIT_SWITCH_LIBS = 75

logging.basicConfig(stream=sys.stdout, level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("capture")


def die_with_parent():
    """Exit when the plugin backend exits (no orphan holding the port)."""
    try:
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        libc.prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG
    except Exception:
        pass


# ------------------------------------------------------------------ settings

def load_settings():
    try:
        with open(SETTINGS) as f:
            return json.load(f)
    except Exception:
        return {}


def save_settings(**changes):
    if not SETTINGS:
        return
    s = load_settings()
    s.update(changes)
    tmp = SETTINGS + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(s, f, indent=2)
        os.replace(tmp, SETTINGS)
    except Exception as e:
        log.warning(f"could not save settings: {e}")


# ------------------------------------------------------------------ sources

_node_cache = (0.0, None, [])


def find_node(max_age=5):
    """gamescope's PipeWire video node, plus every video node seen."""
    global _node_cache
    if time.monotonic() - _node_cache[0] < max_age:
        return _node_cache[1], _node_cache[2]
    env = {k: v for k, v in os.environ.items() if k not in ("LD_LIBRARY_PATH", "GST_PLUGIN_PATH", "GI_TYPELIB_PATH")}
    nodes = []
    try:
        out = subprocess.run(["pw-dump"], capture_output=True, text=True, timeout=5, env=env).stdout
        for o in json.loads(out or "[]"):
            if o.get("type") != "PipeWire:Interface:Node":
                continue
            p = (o.get("info") or {}).get("props") or {}
            cls = p.get("media.class", "")
            if "Video" in cls:
                nodes.append({"id": o.get("id"), "serial": p.get("object.serial"),
                              "name": p.get("node.name") or "", "desc": p.get("node.description") or "", "class": cls})
    except Exception as e:
        log.warning(f"pw-dump failed: {e}")
    pick = next((n for n in nodes if "gamescope" in (n["name"] + n["desc"]).lower()), None)
    if pick is None:
        pick = next((n for n in nodes if n["class"] in ("Video/Source", "Stream/Output/Video")), None)
    _node_cache = (time.monotonic(), pick, nodes)
    return pick, nodes


def build_source(variant, node):
    if variant == "test":
        return TEST_SOURCE
    el = Gst.ElementFactory.make("pipewiresrc", None)
    if el is None:
        raise RuntimeError("GStreamer's pipewiresrc element is missing")
    has = lambda prop: el.find_property(prop) is not None
    src = "pipewiresrc do-timestamp=true"
    if has("keepalive-time"):
        src += " keepalive-time=1000"
    if has("always-copy"):
        src += " always-copy=true"
    if node:
        if variant.startswith("target") and has("target-object"):
            src += f' target-object="{node.get("serial") or node["name"]}"'
        else:
            src += f" path={node['id']}"
    if variant.endswith("+raw"):
        src += " ! video/x-raw"  # frames in normal memory, not GPU buffers
    return src


def current_variant():
    if TEST_SOURCE:
        return "test"
    s = load_settings()
    return s.get("capture_variant") or VARIANTS[0]


def audio_source():
    """
    The default output's monitor, i.e. what the game sounds like. If the
    sound server isn't reachable, stream silence instead of failing the whole
    stream (video still works).
    """
    if os.environ.get("DISCORDIO_TEST_AUDIO"):
        return os.environ["DISCORDIO_TEST_AUDIO"]
    try:
        if subprocess.run(["pactl", "info"], capture_output=True, timeout=3).returncode == 0:
            sink = subprocess.run(["pactl", "get-default-sink"], capture_output=True, text=True, timeout=3).stdout.strip()
            return f'pulsesrc device="{sink}.monitor"' if sink else 'pulsesrc device="@DEFAULT_MONITOR@"'
    except Exception:
        pass
    log.warning("sound server not reachable: streaming without game audio")
    return "audiotestsrc is-live=true wave=silence"


# Which plugin file provides each element, to explain why one is missing.
PLUGIN_FILES = {
    "webrtcbin": "libgstwebrtc.so", "pipewiresrc": "libgstpipewire.so", "vp8enc": "libgstvpx.so",
    "rtpvp8pay": "libgstrtp.so", "rtpopuspay": "libgstrtp.so", "opusenc": "libgstopus.so",
    "pulsesrc": "libgstpulseaudio.so", "jpegenc": "libgstjpeg.so", "videorate": "libgstvideorate.so",
    "videoconvert": "libgstvideoconvertscale.so", "videoscale": "libgstvideoconvertscale.so",
    "audioconvert": "libgstaudioconvert.so", "audioresample": "libgstaudioresample.so",
}


def unresolved_libs(path):
    """Every shared library `path` needs that can't be found, not just the first."""
    try:
        r = subprocess.run(["ldd", path], capture_output=True, text=True, timeout=10)
        return sorted({l.split("=>")[0].strip() for l in r.stdout.splitlines() if "not found" in l})
    except Exception:
        return []


def explain_missing(names):
    """For each missing element: the plugin file, and the error loading it."""
    dirs = [d for d in (os.environ.get("GST_PLUGIN_SYSTEM_PATH_1_0", "") + ":" +
                        os.environ.get("GST_PLUGIN_PATH_1_0", "")).split(":") if d]
    if not dirs:
        dirs = ["/usr/lib/gstreamer-1.0", "/usr/lib64/gstreamer-1.0", "/usr/lib/x86_64-linux-gnu/gstreamer-1.0"]
    out = {}
    for name in names:
        fname = PLUGIN_FILES.get(name)
        if not fname:
            out[name] = "unknown plugin"
            continue
        path = next((os.path.join(d, fname) for d in dirs if os.path.exists(os.path.join(d, fname))), None)
        if path is None and name in ("videoconvert", "videoscale"):
            alt = "libgstvideoconvert.so" if name == "videoconvert" else "libgstvideoscale.so"
            path = next((os.path.join(d, alt) for d in dirs if os.path.exists(os.path.join(d, alt))), None)
        if path is None:
            out[name] = f"{fname} isn't installed (looked in {', '.join(dirs)})"
            continue
        try:
            # Loading it directly also repairs a stale plugin cache for this run.
            Gst.Registry.get().add_plugin(Gst.Plugin.load_file(path))
            out[name] = f"{fname} loaded directly (the plugin cache was stale)"
        except Exception as e:
            out[name] = f"{fname} won't load: {getattr(e, 'message', e)}"
            gone = unresolved_libs(path)
            if gone:
                out[name] += f" (all missing libraries: {', '.join(gone)})"
    return out


def missing_elements():
    need = ["pipewiresrc", "videoconvert", "videoscale", "videorate", "vp8enc", "rtpvp8pay",
            "pulsesrc", "audioconvert", "audioresample", "opusenc", "rtpopuspay", "webrtcbin", "jpegenc"]
    return [n for n in need if Gst.ElementFactory.find(n) is None]


# ------------------------------------------------------------------ preview

GST_ENV_KEYS = ("LD_LIBRARY_PATH", "GI_TYPELIB_PATH", "GST_PLUGIN_PATH", "GST_PLUGIN_PATH_1_0",
                "GST_PLUGIN_SYSTEM_PATH", "GST_PLUGIN_SYSTEM_PATH_1_0", "GST_REGISTRY", "GST_REGISTRY_1_0",
                "GST_PLUGIN_SCANNER", "GST_PLUGIN_SCANNER_1_0", "GST_REGISTRY_FORK")


def gst_env(libs, bundled, cache_dir):
    """
    Environment for one GStreamer set, fully isolated from the other. Mixing
    them (bundled plugins + the system's plugin cache and scanner) makes
    plugins like webrtcbin fail to load and get skipped from then on.
    """
    env = {}
    cache_dir = cache_dir or tempfile.gettempdir()
    env["GST_REGISTRY_1_0"] = os.path.join(cache_dir, f"gst-registry-{libs}.bin")
    if libs == "bundled" and bundled and os.path.isdir(bundled):
        plugins = os.path.join(bundled, "gstreamer-1.0")
        env["LD_LIBRARY_PATH"] = bundled
        env["GI_TYPELIB_PATH"] = os.path.join(bundled, "girepository-1.0")
        env["GST_PLUGIN_SYSTEM_PATH_1_0"] = plugins  # only the bundled plugins
        env["GST_PLUGIN_PATH_1_0"] = ""
        scanner = os.path.join(plugins, "gst-plugin-scanner")
        if os.path.exists(scanner):
            env["GST_PLUGIN_SCANNER_1_0"] = scanner
        else:
            env["GST_REGISTRY_FORK"] = "no"  # scan in-process with the bundled libs
    return env


def env_for(libs):
    env = {k: v for k, v in os.environ.items() if k not in GST_ENV_KEYS}
    env.update(gst_env(libs, os.environ.get("DISCORDIO_BUNDLED_DIR", ""), os.environ.get("DISCORDIO_CACHE_DIR")))
    env["DISCORDIO_LIBS"] = libs
    return env


def child_grab(variant, node_json, out_path, timeout_s=4):
    """Runs in a child process: write one JPEG frame to out_path."""
    Gst.init(None)
    node = json.loads(node_json or "null")
    pipe = Gst.parse_launch(
        f"{build_source(variant, node)} ! videoconvert ! videoscale add-borders=true ! "
        "video/x-raw,width=640,height=360,pixel-aspect-ratio=1/1 ! "
        "jpegenc quality=80 ! appsink name=sink max-buffers=1 drop=true sync=false"
    )
    pipe.set_state(Gst.State.PLAYING)
    sample = pipe.get_by_name("sink").emit("try-pull-sample", timeout_s * Gst.SECOND)
    if sample is None:
        notes = []
        bus = pipe.get_bus()
        while True:
            msg = bus.pop_filtered(Gst.MessageType.ERROR | Gst.MessageType.WARNING)
            if not msg:
                break
            err, _ = msg.parse_error() if msg.type == Gst.MessageType.ERROR else msg.parse_warning()
            notes.append(err.message)
        print("; ".join(notes) or f"no frame within {timeout_s}s", file=sys.stderr, flush=True)
        os._exit(1)
    buf = sample.get_buffer()
    ok, info = buf.map(Gst.MapFlags.READ)
    with open(out_path, "wb") as f:
        f.write(bytes(info.data))
    os._exit(0)  # skip teardown: a stuck source can block set_state(NULL)


async def grab(variant, libs, node, timeout_s=7):
    fd, out = tempfile.mkstemp(suffix=".jpg")
    os.close(fd)
    proc = await asyncio.create_subprocess_exec(
        sys.executable, os.path.abspath(__file__), "--grab", variant, json.dumps(node), out,
        env=env_for(libs), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        _, err = await asyncio.wait_for(proc.communicate(), timeout_s)
        if proc.returncode == 0 and os.path.getsize(out) > 0:
            with open(out, "rb") as f:
                return f.read(), None
        lines = [l for l in err.decode("utf-8", "replace").splitlines() if l.strip()]
        return None, lines[-1] if lines else f"exit {proc.returncode}"
    except asyncio.TimeoutError:
        proc.kill()
        return None, "hung: the source never delivered a frame"
    finally:
        try:
            os.remove(out)
        except OSError:
            pass


# ------------------------------------------------------------------ server

class Helper:
    def __init__(self, loop):
        self.loop = loop
        self.probe_task = None
        self.probe_status = ""
        self.probe_log = []
        self.last_error = None
        self.last_preview = 0.0
        self.session = None
        self.started = time.time()

    # -- method search

    async def probe(self, node):
        other = "system" if MY_LIBS == "bundled" else "bundled"
        combos = [(v, MY_LIBS) for v in VARIANTS]
        # Only try the other GStreamer if it can actually stream (has webrtcbin
        # etc.), otherwise the helper would switch back and forth.
        other_missing = await asyncio.to_thread(check_other_libs, other)
        if other_missing == []:
            combos += [(v, other) for v in VARIANTS]
        else:
            log.info(f"not trying {other} GStreamer for capture: missing {', '.join(other_missing or ['everything'])}")
        self.probe_log = []
        for i, (variant, libs) in enumerate(combos, 1):
            self.probe_status = f"Finding a capture method that works here ({i}/{len(combos)}: {variant}, {libs} GStreamer)..."
            jpeg, err = await grab(variant, libs, node)
            line = f"{variant} / {libs}: {'works' if jpeg else err}"
            self.probe_log.append(line)
            (log.info if jpeg else log.warning)(f"capture method {line}")
            if jpeg:
                save_settings(capture_variant=variant, capture_libs=libs)
                if libs != MY_LIBS:
                    self.probe_status = f"Works with {libs} GStreamer; restarting the capture helper..."
                    self.loop.call_later(0.5, lambda: os._exit(EXIT_SWITCH_LIBS))
                else:
                    self.probe_status = ""
                return
        self.probe_status = ""
        self.last_error = "no capture method delivered a frame: " + " | ".join(self.probe_log[-3:])
        log.error(self.last_error)

    async def preview(self, request):
        from aiohttp import web  # type: ignore
        h = {"Cache-Control": "no-store"}
        if self.probe_task and not self.probe_task.done():
            return web.Response(status=202, text=self.probe_status, headers=h)
        if TEST_SOURCE:
            jpeg, err = await grab("test", MY_LIBS, None)
        else:
            node, nodes = find_node()
            if not node:
                seen = ", ".join(f"{n['name']} [{n['class']}]" for n in nodes) or "none"
                self.last_error = f"gamescope's video feed isn't in PipeWire (video nodes seen: {seen})"
                return web.Response(status=503, text=self.last_error, headers=h)
            s = load_settings()
            variant, libs = s.get("capture_variant"), s.get("capture_libs") or MY_LIBS
            jpeg, err = (None, None)
            if variant and libs == MY_LIBS:
                jpeg, err = await grab(variant, libs, node)
            if jpeg is None:
                if variant:
                    log.warning(f"saved method {variant} failed ({err}); searching again")
                self.probe_task = self.loop.create_task(self.probe(node))
                self.probe_status = "Finding a capture method that works here..."
                return web.Response(status=202, text=self.probe_status, headers=h)
        if jpeg is None:
            self.last_error = err
            return web.Response(status=503, text=err, headers=h)
        self.last_preview = time.time()
        self.last_error = None
        return web.Response(body=jpeg, content_type="image/jpeg", headers=h)

    async def status(self, request):
        from aiohttp import web  # type: ignore
        node, nodes = find_node()
        s = load_settings()
        return web.json_response({
            "pid": os.getpid(),
            "uptime_s": round(time.time() - self.started),
            "libs": MY_LIBS,
            "gstreamer": Gst.version_string(),
            "missing_elements": missing_elements(),
            "missing_details": explain_missing(missing_elements()),
            "node": node,
            "video_nodes": nodes,
            "method": s.get("capture_variant") or None,
            "method_libs": s.get("capture_libs") or None,
            "probing": bool(self.probe_task and not self.probe_task.done()),
            "probe_status": self.probe_status,
            "probe_log": self.probe_log[-8:],
            "last_preview_age_s": round(time.time() - self.last_preview) if self.last_preview else None,
            "stream": self.session.info() if self.session else None,
            "last_error": self.last_error,
        })

    async def webrtc(self, request):
        from aiohttp import web, WSMsgType  # type: ignore
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        if self.session:
            self.session.close()
        session = Session(self, ws)
        self.session = session
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                await session.handle(json.loads(msg.data))
        finally:
            session.close()
            if self.session is session:
                self.session = None
        return ws


class Session:
    """One Go Live stream: capture pipeline + webrtcbin, answering the page's offer."""

    def __init__(self, helper, ws):
        gi.require_version("GstWebRTC", "1.0")
        gi.require_version("GstSdp", "1.0")
        self.helper, self.ws, self.loop = helper, ws, helper.loop
        self.pipe = None
        self.webrtc = None
        self.frames = 0
        self.last_frame = 0.0
        self.started = time.time()
        self.preset = ""
        self.error = None

    def info(self):
        return {
            "running": self.pipe is not None,
            "preset": self.preset,
            "frames": self.frames,
            "last_frame_age_s": round(time.time() - self.last_frame, 1) if self.last_frame else None,
            "error": self.error,
        }

    def send(self, payload):
        if not self.ws.closed:
            asyncio.run_coroutine_threadsafe(self.ws.send_json(payload), self.loop)

    def fail(self, message):
        self.error = message
        self.helper.last_error = message
        log.error(f"stream: {message}")
        self.send({"error": message})

    async def handle(self, data):
        from gi.repository import GstSdp, GstWebRTC  # noqa
        if "offer" in data:
            res, sdp = GstSdp.SDPMessage.new_from_text(data["offer"]["sdp"])
            if data.get("constraints"):
                log.info(f"Discord asked for: {data['constraints']}")
            if not self.webrtc:
                try:
                    vpt, apt = payload_types(sdp)
                    await asyncio.wait_for(asyncio.to_thread(self.start, vpt, apt), 10)
                except asyncio.TimeoutError:
                    return self.fail("the capture pipeline didn't start within 10s")
                except Exception as e:
                    return self.fail(f"couldn't start capture: {e}")
            offer = GstWebRTC.WebRTCSessionDescription.new(GstWebRTC.WebRTCSDPType.OFFER, sdp)
            self.webrtc.emit("set-remote-description", offer, Gst.Promise.new_with_change_func(self.on_offer_set, None, None))
        elif "ice" in data and self.webrtc:
            self.webrtc.emit("add-ice-candidate", data["ice"]["sdpMLineIndex"], data["ice"]["candidate"])
        elif "stop" in data:
            await self.ws.close()

    def start(self, vpt, apt):
        height, fps, bitrate = stream_settings(load_settings())
        node = None if TEST_SOURCE else find_node(0)[0]
        if not TEST_SOURCE and not node:
            raise RuntimeError("gamescope's video feed isn't in PipeWire")
        if height:
            width = int(round(height * 16 / 9 / 2) * 2)
            scale = (f"videoscale add-borders=true ! videorate drop-only=true ! "
                     f"video/x-raw,width={width},height={height},pixel-aspect-ratio=1/1,framerate={fps}/1 !")
            self.preset = f"{height}p{fps}"
        else:
            scale = f"videorate drop-only=true ! video/x-raw,framerate={fps}/1 !"
            self.preset = f"source@{fps}"
        desc = (
            f"webrtcbin name=send latency=0 bundle-policy=max-bundle "
            f"{build_source(current_variant(), node)} ! identity name=frames silent=true ! videoconvert ! {scale} "
            f"queue max-size-buffers=2 leaky=downstream ! "
            f"vp8enc deadline=1 cpu-used=8 threads={max(2, min(8, (os.cpu_count() or 4) // 2))} "
            f"end-usage=cbr target-bitrate={bitrate} keyframe-max-dist={fps * 2} error-resilient=partitions lag-in-frames=0 ! "
            f"rtpvp8pay picture-id-mode=15-bit ! queue ! application/x-rtp,media=video,encoding-name=VP8,payload={vpt} ! send. "
            f"{audio_source()} ! audioconvert ! audioresample ! queue ! opusenc ! rtpopuspay ! "
            f"queue ! application/x-rtp,media=audio,encoding-name=OPUS,payload={apt} ! send."
        )
        log.info(f"starting stream {self.preset} with method {current_variant()}")
        self.pipe = Gst.parse_launch(desc)
        self.webrtc = self.pipe.get_by_name("send")
        self.webrtc.connect("on-ice-candidate", lambda _, idx, cand: self.send({"ice": {"candidate": cand, "sdpMLineIndex": idx}}))
        # Count frames coming out of the source, for diagnostics and the stall warning.
        self.pipe.get_by_name("frames").get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, self.on_frame)
        self.pipe.set_state(Gst.State.PLAYING)
        self.loop.call_soon_threadsafe(lambda: self.loop.create_task(self.watch()))

    def on_frame(self, pad, info):
        self.frames += 1
        self.last_frame = time.time()
        return Gst.PadProbeReturn.OK

    async def watch(self):
        """Report pipeline errors and a stalled feed instead of streaming nothing silently."""
        warned = False
        begin = time.time()
        while self.pipe is not None:
            # No GLib main loop here, so poll the bus.
            bus = self.pipe.get_bus()
            while True:
                msg = bus.pop_filtered(Gst.MessageType.ERROR | Gst.MessageType.WARNING)
                if not msg:
                    break
                if msg.type == Gst.MessageType.ERROR:
                    err, _ = msg.parse_error()
                    self.fail(err.message)
                else:
                    w, _ = msg.parse_warning()
                    log.warning(f"stream: {w.message}")
            if time.time() - begin < 6:
                await asyncio.sleep(1)
                continue
            stale = not self.last_frame or time.time() - self.last_frame > 5
            if stale and not warned:
                msg = "no frames from gamescope for 5s (try the preview to re-detect the capture method)"
                log.warning(f"stream: {msg}")
                self.helper.last_error = msg
                self.send({"status": {"warning": msg}})
                warned = True
            elif not stale and warned:
                warned = False
            await asyncio.sleep(1)

    def on_offer_set(self, promise, _a, _b):
        promise.wait()
        self.webrtc.emit("create-answer", None, Gst.Promise.new_with_change_func(self.on_answer, None, None))

    def on_answer(self, promise, _a, _b):
        promise.wait()
        reply = promise.get_reply()
        answer = reply.get_value("answer") if reply else None
        if answer is None:
            self.loop.call_soon_threadsafe(self.fail, "couldn't create a WebRTC answer (the capture pipeline failed to start)")
            return
        self.webrtc.emit("set-local-description", answer, Gst.Promise.new())
        self.send({"sdp": {"type": "answer", "sdp": answer.sdp.as_text()}})

    def close(self):
        if self.pipe is not None:
            pipe, self.pipe = self.pipe, None
            # Teardown off the event loop; a stuck source can block it.
            self.loop.run_in_executor(None, pipe.set_state, Gst.State.NULL)
            log.info(f"stream stopped after {round(time.time() - self.started)}s, {self.frames} frames")
        self.webrtc = None


def payload_types(sdp):
    vpt = apt = None
    for i in range(sdp.medias_len()):
        media = sdp.get_media(i)
        for j in range(media.formats_len()):
            fmt = media.get_format(j)
            if fmt == "webrtc-datachannel":
                continue
            caps = media.get_caps_from_media(int(fmt))
            name = caps.get_structure(0).get_string("encoding-name") if caps else None
            if name == "VP8" and vpt is None:
                vpt = int(fmt)
            elif name == "OPUS" and apt is None:
                apt = int(fmt)
    if vpt is None or apt is None:
        raise RuntimeError(f"Discord's offer has no VP8/Opus (video {vpt}, audio {apt})")
    return vpt, apt


def stream_settings(s):
    """(height or None for source, fps, local bitrate) from the plugin settings."""
    heights = {"480": 480, "720": 720, "1080": 1080, "1440": 1440, "2160": 2160, "source": None}
    height = heights.get(str(s.get("stream_resolution", "720")), 720)
    try:
        fps = int(s.get("stream_fps", 30))
    except Exception:
        fps = 30
    if fps not in (5, 10, 15, 24, 30, 45, 60):
        fps = 30
    h = height or 1440
    # Discord re-encodes what it receives, so this local hop can be generous.
    bitrate = int(min(40_000_000, max(3_000_000, (h * 16 / 9) * h * fps * 0.12)))
    return height, fps, bitrate


def check_other_libs(libs):
    """Missing elements with the other GStreamer set, or None if it can't load at all."""
    try:
        r = subprocess.run([sys.executable, os.path.abspath(__file__), "--check"],
                           env=env_for(libs), capture_output=True, text=True, timeout=20)
        return json.loads(r.stdout.strip().splitlines()[-1]) if r.returncode == 0 else None
    except Exception as e:
        log.warning(f"checking {libs} GStreamer failed: {e}")
        return None


def main():
    from aiohttp import web  # type: ignore
    die_with_parent()
    Gst.init(None)
    loop = asyncio.new_event_loop()  # explicit: newer Python won't create one implicitly
    asyncio.set_event_loop(loop)
    helper = Helper(loop)
    app = web.Application()
    app.add_routes([
        web.get("/status", helper.status),
        web.get("/preview", helper.preview),
        web.get("/webrtc", helper.webrtc),
    ])
    missing = missing_elements()
    log.info(f"capture helper {os.getpid()} on 127.0.0.1:{PORT}, {MY_LIBS} {Gst.version_string()}"
             + (f", missing: {', '.join(missing)}" if missing else ""))
    if missing:
        for name, why in explain_missing(missing).items():
            log.warning(f"missing {name}: {why}")
        missing = missing_elements()  # some may have been repaired just now
    if missing and not TEST_SOURCE:
        # The bundled GStreamer may lack parts SteamOS's own has (or the other
        # way around): check the other set and switch if it's complete.
        other = "system" if MY_LIBS == "bundled" else "bundled"
        other_missing = check_other_libs(other)
        if other_missing == []:
            log.info(f"{other} GStreamer has everything ({', '.join(missing)} missing here); switching")
            save_settings(capture_libs=other, capture_variant="")
            os._exit(EXIT_SWITCH_LIBS)
        log.error(f"{other} GStreamer is also incomplete: {', '.join(other_missing or ['unusable'])}")
    node, nodes = find_node()
    if node:
        log.info(f"gamescope feed: node {node['id']} ({node['name']}), method {current_variant()}")
    else:
        log.warning("gamescope's video feed not found yet: " + (", ".join(n["name"] for n in nodes) or "no video nodes"))
    # access_log=None: request lines every 3s buried the useful messages in Diagnostics.
    web.run_app(app, host="127.0.0.1", port=PORT, loop=loop, print=None, handle_signals=True, access_log=None)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--check":
        Gst.init(None)
        print(json.dumps(missing_elements()), flush=True)
        os._exit(0)
    if len(sys.argv) > 1 and sys.argv[1] == "--grab":
        try:
            child_grab(sys.argv[2], sys.argv[3], sys.argv[4])
        except Exception as e:
            print(f"{type(e).__name__}: {e}", file=sys.stderr, flush=True)
            os._exit(1)
    else:
        main()
