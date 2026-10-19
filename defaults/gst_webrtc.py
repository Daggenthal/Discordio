#Most of the code here is adapted from https://gitlab.freedesktop.org/gstreamer/gstreamer/-/blob/main/subprojects/gst-examples/webrtc/sendrecv/gst/webrtc_sendrecv.py
#Code for setting up pipelinesrc and audio pipeline is from https://github.com/marissa999/decky-recorder

import aiohttp # type: ignore
from aiohttp import web # type: ignore
from logging import getLogger
from gi import require_version # type: ignore
from asyncio import run_coroutine_threadsafe, get_event_loop
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
  pipewiresrc do-timestamp=true ! videoconvert ! {scale}
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


class WebRTCServer:
    def __init__(self, app = web.Application()) -> None:
        Gst.init(None)

        self.loop = get_event_loop()
        self.app = app
        self.app.add_routes([web.get("/webrtc", self.websocket_handler)])

        self.webrtc = None
        self.remote_ws = None
        self.pipe = None

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
                            self.start_pipeline(create_offer=False, video_pt=pts["VP8"], audio_pt=pts["OPUS"])
                        except Exception as e:
                            # Tell the page instead of leaving it waiting forever.
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


if __name__ == "__main__":
    main()