"""Plugin settings, stored as JSON in Decky's settings directory."""

import json
from pathlib import Path

DEFAULTS = {
    "stream_resolution": "720",
    "stream_fps": 30,
    "overlay_enabled": True,
    "overlay_position": "top-left",
    "overlay_engine": "auto",
    # Show the overlay while a call rings or you're in one, even when it's off.
    "overlay_calls": True,
    "message_popups": True,
    "message_position": "top-left",
    "message_duration": 8,
    # Chosen automatically by the capture helper; "" means "not found yet".
    "capture_variant": "",
    "capture_libs": "bundled",
}

RESOLUTIONS = {"480", "720", "1080", "1440", "2160", "source"}
FRAME_RATES = {5, 10, 15, 24, 30, 45, 60}
OVERLAY_POSITIONS = {"top-left", "top-right", "bottom-left", "bottom-right"}
OVERLAY_ENGINES = {"auto", "gamescope", "steam"}
MESSAGE_DURATIONS = {4, 8, 15, 30}
LEGACY_PRESETS = {
    "720p30": ("720", 30), "720p60": ("720", 60), "1080p30": ("1080", 30),
    "1080p60": ("1080", 60), "1440p60": ("1440", 60), "source": ("source", 60),
}


class Settings:
    def __init__(self, directory):
        self.dir = Path(directory)
        self.file = self.dir / "settings.json"

    def raw(self):
        try:
            return json.loads(self.file.read_text())
        except Exception:
            return {}

    def load(self):
        raw = self.raw()
        # Migrate the old combined stream presets.
        if "stream_resolution" not in raw and raw.get("stream_quality") in LEGACY_PRESETS:
            raw["stream_resolution"], raw["stream_fps"] = LEGACY_PRESETS[raw["stream_quality"]]
        s = {**DEFAULTS, **raw}
        s.pop("stream_quality", None)
        if str(s["stream_resolution"]) not in RESOLUTIONS:
            s["stream_resolution"] = DEFAULTS["stream_resolution"]
        s["stream_resolution"] = str(s["stream_resolution"])
        if s["stream_fps"] not in FRAME_RATES:
            s["stream_fps"] = DEFAULTS["stream_fps"]
        return s

    def update(self, **changes):
        s = self.load()
        s.update(changes)
        self.dir.mkdir(parents=True, exist_ok=True)
        tmp = self.file.with_suffix(".tmp")
        tmp.write_text(json.dumps(s, indent=2))
        tmp.replace(self.file)  # atomic, so the capture helper never reads half a file
        return s
