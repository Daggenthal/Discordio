#Most of the code here is adapted from https://gitlab.freedesktop.org/gstreamer/gstreamer/-/blob/main/subprojects/gst-examples/webrtc/sendrecv/gst/webrtc_sendrecv.py
#Code for setting up pipelinesrc and audio pipeline is from https://github.com/marissa999/decky-recorder

import aiohttp # type: ignore
from aiohttp import web # type: ignore
from logging import getLogger
from gi import require_version # type: ignore
from asyncio import run_coroutine_threadsafe, new_event_loop, set_event_loop, to_thread, wait_for
from asyncio import TimeoutError as AsyncTimeout
from subprocess import getoutput
import json
import logging
import os
import sys

log = getLogger("webrtc")
logging.basicConfig(stream=sys.stdout, level=logging.INFO, format="%(levelname)s %(message)s")

require_version("Gst", "1.0")
require_version("GstWebRTC", "1.0")
require_version("GstSdp", "1.0")
from gi.repository import Gst, GstWebRTC, GstSdp # type: ignore

# No STUN/TURN: both ends are on this machine, so loopback host candidates
# are enough. The original routed through a public GStreamer test TURN server,
# which added a pointless third party to a local connection.
PIPELINE_DESC = """
  webrtcbin name=send latency=0 bundle-policy=max-bundle
  {source} ! videoconvert ! {scale}
  queue max-size-buffers=2 leaky=downstream !
  vp8enc deadline=1 cpu-used=8 threads={threads} end-usage=cbr target-bitrate={bitrate}
    keyframe-max-dist={keyint} error-resilient=partitions lag-in-frames=0 !
  rtpvp8pay picture-id-mode=15-bit !
  queue ! application/x-rtp,media=video,encoding-name=VP8,payload={video_pt} ! send.
  pulsesrc device="{monitor}" ! audioconvert ! audioresample ! queue ! opusenc ! rtpopuspay !
  queue ! application/x-rtp,media=audio,encoding-name=OPUS,payload={audio_pt} ! send.
"""

# Stream resolution (output height, or "source") and frame rate, chosen in the
# QAM. Discord re-encodes what it receives, so this local hop uses a generous
# bitrate scaled to pixels per second.
RESOLUTIONS = {"480": 480, "720": 720, "1080": 1080, "1440": 1440, "2160": 2160, "source": None}
FRAME_RATES = {5, 10, 15, 24, 30, 45, 60}
LEGACY_PRESETS = {
    "720p30": ("720", 30), "720p60": ("720", 60), "1080p30": ("1080", 30),
    "1080p60": ("1080", 60), "1440p60": ("1440", 60), "source": ("source", 60),
}


def read_quality():
    """Returns (resolution key, fps) from the plugin settings file."""
    path = os.environ.get("DECKCORD_SETTINGS")
    try:
        with open(path) as f:
            settings = json.load(f)
    except Exception:
        settings = {}
    res = str(settings.get("stream_resolution", ""))
    fps = settings.get("stream_fps")
    if res not in RESOLUTIONS and settings.get("stream_quality") in LEGACY_PRESETS:
        res, fps = LEGACY_PRESETS[settings["stream_quality"]]
    if res not in RESOLUTIONS:
        res = "720"
    try:
        fps = int(fps)
    except Exception:
        fps = 30
    if fps not in FRAME_RATES:
        fps = 30
    return res, fps


def bitrate_for(height, fps):
    h = height or 1440
    pixels_per_sec = (h * 16 / 9) * h * fps
    return int(min(40_000_000, max(3_000_000, pixels_per_sec * 0.12)))


def build_pipeline(video_pt, audio_pt, monitor):
    res, fps = read_quality()
    height = RESOLUTIONS[res]
    width = int(round(height * 16 / 9 / 2) * 2) if height else None
    bitrate = bitrate_for(height, fps)
    preset = f"{res}p{fps}" if height else f"source@{fps}"
    if width:
        # videoscale letterboxes instead of stretching when aspect ratios differ.
        scale = (f"videoscale add-borders=true ! videorate drop-only=true ! "
                 f"video/x-raw,width={width},height={height},pixel-aspect-ratio=1/1,framerate={fps}/1 !")
    else:
        scale = f"videorate drop-only=true ! video/x-raw,framerate={fps}/1 !"
    log.info(f"Capture preset {preset}: {width or 'source'}x{height or 'source'} @ {fps} fps, {bitrate // 1000} kbps")
    return PIPELINE_DESC.format(
        source=video_source(),
        scale=scale,
        threads=max(2, min(8, (os.cpu_count() or 4) // 2)),
        bitrate=bitrate,
        keyint=fps * 2,  # a keyframe every 2s so the stream recovers quickly
        video_pt=video_pt,
        audio_pt=audio_pt,
        monitor=monitor,
    )


def default_monitor():
    """Monitor source of the default output, i.e. the game's audio."""
    try:
        sink = getoutput("pactl get-default-sink").strip().splitlines()[0]
        if sink and "error" not in sink.lower() and "not found" not in sink.lower():
            return sink + ".monitor"
    except Exception:
        pass
    log.warning("pactl could not report the default sink; using the default source for stream audio")
    return ""


def get_payload_types(sdpmsg, video_encoding, audio_encoding):
    video_pt = None
    audio_pt = None

    for i in range(0, sdpmsg.medias_len()):
        media = sdpmsg.get_media(i)

        for j in range(0, media.formats_len()):
            fmt = media.get_format(j)

            if fmt == "webrtc-datachannel":
                continue

            pt = int(fmt)
            caps = media.get_caps_from_media(pt)
            s = caps.get_structure(0)
            encoding_name = s.get_string("encoding-name")

            if video_pt is None and encoding_name == video_encoding:
                video_pt = pt

            elif audio_pt is None and encoding_name == audio_encoding:
                audio_pt = pt

    ret = {video_encoding: video_pt, audio_encoding: audio_pt}
    print(ret)
    return ret


# The exact video source the stream uses, so the preview shows precisely what
# viewers will get. DISCORDIO_TEST_SRC lets tests swap in a test pattern.
TEST_SOURCE = os.environ.get("DISCORDIO_TEST_SRC")


def find_capture_node():
    """
    Find gamescope's PipeWire video node (the composited game output Steam's
    own recording uses). A bare pipewiresrc picks "some" default video source,
    and when there isn't an obvious one it waits forever, which looked like
    Go Live and the preview hanging with no information.
    """
    import subprocess
    env = {k: v for k, v in os.environ.items() if k not in ("LD_LIBRARY_PATH", "GST_PLUGIN_PATH", "GI_TYPELIB_PATH")}
    try:
        out = subprocess.run(["pw-dump"], capture_output=True, text=True, timeout=5, env=env).stdout
        objs = json.loads(out or "[]")
    except Exception as e:
        log.warning(f"pw-dump failed, using the default video source: {e}")
        return None, []
    nodes = []
    for o in objs:
        if o.get("type") != "PipeWire:Interface:Node":
            continue
        props = (o.get("info") or {}).get("props") or {}
        cls = props.get("media.class", "")
        if "Video" not in cls:
            continue
        nodes.append({
            "id": o.get("id"),
            "serial": props.get("object.serial"),
            "name": props.get("node.name") or "",
            "desc": props.get("node.description") or props.get("media.name") or "",
            "class": cls,
        })
    pick = next((n for n in nodes if "gamescope" in (n["name"] + n["desc"]).lower()), None)
    if pick is None:
        pick = next((n for n in nodes if n["class"] in ("Video/Source", "Stream/Output/Video")), None)
    return pick, nodes


CAPTURE_NODE = None
CAPTURE_NODES = []


# ---- capture method selection ----------------------------------------------
#
# gamescope's PipeWire feed only starts sending frames once the format is
# negotiated, and which settings work depends on the PipeWire / GStreamer
# versions involved (the bundled plugin can be older than the system's).
# So the helper tries a few combinations, each in a separate process that can
# be killed if it hangs, remembers the first that delivers a frame, and uses it
# for both the preview and the stream.

VARIANTS = ["target+raw", "path+raw", "target", "path"]
MY_LIBS = os.environ.get("DISCORDIO_LIBS", "bundled")


def load_settings_file():
    try:
        with open(os.environ.get("DECKCORD_SETTINGS", "")) as f:
            return json.load(f)
    except Exception:
        return {}


def save_capture_choice(variant, libs):
    path = os.environ.get("DECKCORD_SETTINGS")
    if not path:
        return
    s = load_settings_file()
    s["capture_variant"], s["capture_libs"] = variant, libs
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            json.dump(s, f, indent=2)
    except Exception as e:
        log.warning(f"Could not save capture method: {e}")


def build_source(variant, node):
    el = Gst.ElementFactory.make("pipewiresrc", None)
    if el is None:
        raise RuntimeError("GStreamer's pipewiresrc element is missing")
    has = lambda prop: el.find_property(prop) is not None
    src = "pipewiresrc do-timestamp=true"
    # Only properties this PipeWire version knows; an unknown one makes the
    # whole pipeline fail to parse.
    if has("keepalive-time"):
        src += " keepalive-time=1000"  # keep frames flowing when the screen is static
    if has("always-copy"):
        src += " always-copy=true"
    if node:
        if variant.startswith("target") and has("target-object"):
            src += f' target-object="{node.get("serial") or node["name"]}"'
        else:
            src += f" path={node['id']}"
    if variant.endswith("+raw"):
        # Ask for frames in normal memory instead of GPU buffers.
        src += " ! video/x-raw"
    return src


def video_source():
    if TEST_SOURCE:
        return TEST_SOURCE
    global CAPTURE_NODE, CAPTURE_NODES
    CAPTURE_NODE, CAPTURE_NODES = find_capture_node()
    variant = load_settings_file().get("capture_variant") or VARIANTS[0]
    if CAPTURE_NODE:
        log.info(f"Capture source: {CAPTURE_NODE['name'] or CAPTURE_NODE['desc']} (node {CAPTURE_NODE['id']}), method {variant}, {MY_LIBS} GStreamer")
    else:
        names = ", ".join(f"{n['name']} [{n['class']}]" for n in CAPTURE_NODES) or "none"
        log.warning(f"No gamescope video node found; video nodes seen: {names}")
    return build_source(variant, CAPTURE_NODE)


def check_element(name):
    if Gst.ElementFactory.find(name) is None:
        raise RuntimeError(f"GStreamer element '{name}' is missing")


def grab_one(src, out_path, timeout_s=4, width=640, height=360):
    """Runs in a child process: write one JPEG frame from `src` to out_path."""
    pipe = Gst.parse_launch(
        f"{src} ! videoconvert ! videoscale add-borders=true ! "
        f"video/x-raw,width={width},height={height},pixel-aspect-ratio=1/1 ! "
        "jpegenc quality=80 ! appsink name=sink max-buffers=1 drop=true sync=false"
    )
    sink = pipe.get_by_name("sink")
    pipe.set_state(Gst.State.PLAYING)
    sample = sink.emit("try-pull-sample", timeout_s * Gst.SECOND)
    if sample is None:
        bus = pipe.get_bus()
        notes = []
        while True:
            msg = bus.pop_filtered(Gst.MessageType.ERROR | Gst.MessageType.WARNING)
            if not msg:
                break
            err, dbg = msg.parse_error() if msg.type == Gst.MessageType.ERROR else msg.parse_warning()
            notes.append(err.message)
        raise RuntimeError("; ".join(notes) or f"no frame within {timeout_s}s")
    buf = sample.get_buffer()
    ok, info = buf.map(Gst.MapFlags.READ)
    try:
        with open(out_path, "wb") as f:
            f.write(bytes(info.data))
    finally:
        buf.unmap(info)
    # No set_state(NULL): a stuck source could block here; the process just exits.
    os._exit(0)


def env_for(libs):
    env = dict(os.environ)
    bundled = os.environ.get("DISCORDIO_BUNDLED_DIR", "")
    for k in ("LD_LIBRARY_PATH", "GI_TYPELIB_PATH", "GST_PLUGIN_PATH"):
        env.pop(k, None)
    if libs == "bundled" and bundled and os.path.isdir(bundled):
        env["LD_LIBRARY_PATH"] = bundled
        env["GI_TYPELIB_PATH"] = os.path.join(bundled, "girepository-1.0")
        env["GST_PLUGIN_PATH"] = os.path.join(bundled, "gstreamer-1.0")
    env["DISCORDIO_LIBS"] = libs
    return env


async def grab_in_child(variant, libs, node, timeout_s=7):
    """Try one capture method in a killable child process. Returns (jpeg, error)."""
    import tempfile
    from asyncio import create_subprocess_exec, wait_for as wf
    from asyncio.subprocess import PIPE
    fd, out = tempfile.mkstemp(suffix=".jpg")
    os.close(fd)
    proc = await create_subprocess_exec(
        sys.executable, os.path.abspath(__file__), "--grab", variant, json.dumps(node or {}), out,
        env=env_for(libs), stdout=PIPE, stderr=PIPE,
    )
    try:
        _, err = await wf(proc.communicate(), timeout_s)
        if proc.returncode == 0 and os.path.getsize(out) > 0:
            with open(out, "rb") as f:
                return f.read(), None
        lines = [l for l in err.decode("utf-8", "replace").splitlines() if l.strip()]
        return None, (lines[-1] if lines else f"exit {proc.returncode}")
    except AsyncTimeout:
        proc.kill()
        return None, "hung (no frame, source never started)"
    finally:
        try:
            os.remove(out)
        except OSError:
            pass


class WebRTCServer:
    def __init__(self, app = web.Application()) -> None:
        Gst.init(None)

        # Create the loop explicitly. Newer Python (as shipped on current SteamOS)
        # no longer makes one implicitly, so get_event_loop() here raised
        # "There is no current event loop" and the helper died at startup,
        # which is why Go Live never captured anything.
        self.loop = new_event_loop()
        set_event_loop(self.loop)
        self.app = app
        self.app.add_routes([
            web.get("/webrtc", self.websocket_handler),
            web.get("/preview", self.preview_handler),
        ])

        self.webrtc = None
        self.remote_ws = None
        self.pipe = None
        self.probe_task = None
        self.probe_status = "Starting capture..."

    def start_pipeline(self, create_offer=True, audio_pt=96, video_pt=97):
        log.info(f"Creating pipeline, create_offer: {create_offer}")
        desc = build_pipeline(video_pt, audio_pt, default_monitor())
        # An empty device= means "default source" for pulsesrc.
        desc = desc.replace('pulsesrc device=""', 'pulsesrc')
        self.pipe = Gst.parse_launch(desc)
        self.webrtc = self.pipe.get_by_name("send")
        self.webrtc.connect("on-negotiation-needed", self.on_negotiation_needed, create_offer)
        self.webrtc.connect("on-ice-candidate", self.send_ice_candidate_message)
        self.pipe.set_state(Gst.State.PLAYING)

    def close_pipeline(self):
        if self.pipe:
            self.pipe.set_state(Gst.State.NULL)
            self.pipe = None

        self.webrtc = None
    
    def on_negotiation_needed(self, _, create_offer):
        if create_offer:
            log.info('Call was connected: creating offer')
            promise = Gst.Promise.new_with_change_func(self.on_offer_created, None, None)
            self.webrtc.emit('create-offer', None, promise)

    def send_ice_candidate_message(self, _, mlineindex, candidate):
        icemsg = {'ice': {'candidate': candidate, 'sdpMLineIndex': mlineindex}}
        run_coroutine_threadsafe(self.remote_ws.send_json(icemsg), self.loop)

    def on_offer_set(self, promise, _, __):
        assert promise.wait() == Gst.PromiseResult.REPLIED
        promise = Gst.Promise.new_with_change_func(self.on_answer_created, None, None)
        self.webrtc.emit("create-answer", None, promise)

    def on_answer_created(self, promise, _, __):
        assert promise.wait() == Gst.PromiseResult.REPLIED
        reply = promise.get_reply()
        answer = reply.get_value("answer")
        promise = Gst.Promise.new()
        self.webrtc.emit("set-local-description", answer, promise)
        promise.interrupt()
        print(answer)
        self.send_sdp(answer)

    def send_sdp(self, offer):
        text = offer.sdp.as_text()
        log.info("Sending answer:\n%s" % text)
        msg = {'sdp': {'type': 'answer', 'sdp': text}}
        run_coroutine_threadsafe(self.remote_ws.send_json(msg), self.loop)

    async def preview_handler(self, request):
        headers = {"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"}
        if TEST_SOURCE:
            jpeg, err = await grab_in_child("test", MY_LIBS, None)
        else:
            if self.probe_task and not self.probe_task.done():
                return web.Response(status=202, text=self.probe_status, headers=headers)
            node, _ = find_capture_node()
            settings = load_settings_file()
            variant = settings.get("capture_variant")
            libs = settings.get("capture_libs") or MY_LIBS
            if variant and libs == MY_LIBS:
                jpeg, err = await grab_in_child(variant, libs, node)
                if jpeg is None:
                    log.warning(f"Saved capture method {variant} stopped working: {err}; searching again")
            else:
                jpeg, err = None, None
            if jpeg is None:
                if not self.probe_task or self.probe_task.done():
                    self.probe_task = self.loop.create_task(self.probe(node))
                return web.Response(status=202, text=self.probe_status, headers=headers)
        if jpeg is None:
            return web.Response(status=503, text=f"Screen capture (PipeWire): {err}", headers=headers)
        return web.Response(body=jpeg, content_type="image/jpeg", headers=headers)

    async def probe(self, node):
        """Find a capture method that delivers frames. Logs every attempt."""
        if not node:
            self.probe_status = "No gamescope video feed found in PipeWire"
            return
        other = "system" if MY_LIBS == "bundled" else "bundled"
        combos = [(v, MY_LIBS) for v in VARIANTS] + [(v, other) for v in VARIANTS]
        for i, (variant, libs) in enumerate(combos, 1):
            self.probe_status = f"Finding a working capture method ({i}/{len(combos)}: {variant}, {libs} GStreamer)..."
            jpeg, err = await grab_in_child(variant, libs, node)
            if jpeg is not None:
                log.info(f"Capture works with method {variant} using {libs} GStreamer")
                save_capture_choice(variant, libs)
                if libs != MY_LIBS:
                    self.probe_status = f"Found a working method ({libs} GStreamer); restarting the capture helper..."
                    log.info("Restarting the capture helper to switch GStreamer libraries")
                    self.loop.call_later(0.5, lambda: os._exit(75))
                else:
                    self.probe_status = "Capture method found"
                return
            log.warning(f"Capture method {variant} ({libs} GStreamer) failed: {err}")
        self.probe_status = "No capture method delivered a frame; see the capture log in Diagnostics"
        log.error(self.probe_status)

    async def websocket_handler(self, request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        self.remote_ws = ws

        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                data = msg.json()

                if "offer" in data:
                    res, sdpmsg = GstSdp.SDPMessage.new_from_text(data["offer"]["sdp"])
                    if data.get("constraints"):
                        log.info(f"Discord requested: {data['constraints']}")

                    if not self.webrtc:
                        log.info("Incoming call: received an offer, creating pipeline")
                        try:
                            pts = get_payload_types(sdpmsg, video_encoding="VP8", audio_encoding="OPUS")
                            if pts.get("VP8") is None or pts.get("OPUS") is None:
                                raise RuntimeError(f"Discord's offer has no VP8/Opus payload types: {pts}")
                            # Off the event loop: a slow source can block in set_state.
                            await wait_for(
                                to_thread(self.start_pipeline, False, pts["OPUS"], pts["VP8"]), 10
                            )
                        except Exception as e:
                            # Tell the page instead of leaving it waiting forever.
                            if isinstance(e, AsyncTimeout):
                                e = "the capture pipeline didn't start within 10s"
                            log.error(f"Could not start capture: {e}")
                            self.close_pipeline()
                            await ws.send_json({"error": f"Capture failed to start: {e}"})
                            continue

                    assert self.webrtc
                    offer = GstWebRTC.WebRTCSessionDescription.new(GstWebRTC.WebRTCSDPType.OFFER, sdpmsg)
                    promise = Gst.Promise.new_with_change_func(self.on_offer_set, None, None)
                    self.webrtc.emit("set-remote-description", offer, promise)

                elif "ice" in data:
                    assert self.webrtc
                    candidate = data['ice']['candidate']
                    sdpmlineindex = data['ice']['sdpMLineIndex']
                    self.webrtc.emit('add-ice-candidate', sdpmlineindex, candidate)

                elif "stop" in data:
                    await ws.close()
                    break

        self.close_pipeline()
        return ws


def main():
    app = WebRTCServer()
    web.run_app(app.app, host="127.0.0.1", port=65124, loop=app.loop)


if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "--grab":
    # Child process used by grab_in_child().
    Gst.init(None)
    try:
        _variant, _node, _out = sys.argv[2], json.loads(sys.argv[3] or "{}"), sys.argv[4]
        grab_one(TEST_SOURCE if _variant == "test" else build_source(_variant, _node or None), _out)
    except Exception as _e:
        print(f"{type(_e).__name__}: {_e}", file=sys.stderr, flush=True)
        os._exit(1)

if __name__ == "__main__":
    main()