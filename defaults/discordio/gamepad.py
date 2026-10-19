"""
Controller buttons, read straight from Linux's input devices (evdev).

Steam's in-UI controller API changes between client versions (the SteamOS
beta dropped RegisterForControllerStateChanges), so the backend, which runs
as root, reads the physical controllers itself: DualSense, DualShock, Xbox
pads, 8BitDo, the Steam Deck's controls... the same whatever Steam Input
layout a game uses. Button state is turned into the same bit layout as
Steam's controller state and sent to the QAM, which matches shortcuts.
"""

import asyncio
import fcntl
import os
import struct
import time

from . import diag

EV_SYN, EV_KEY, EV_ABS = 0, 1, 3
SYN_REPORT = 0
ABS_Z, ABS_RZ, ABS_HAT0X, ABS_HAT0Y = 2, 5, 16, 17
ABS_GAS, ABS_BRAKE = 9, 10  # some pads report triggers here
BTN_GAMEPAD = 304

# evdev key code -> bit in Steam's controller state layout
KEY_BITS = {
    313: 0,   # BTN_TR2  R2 (digital)
    312: 1,   # BTN_TL2  L2 (digital)
    311: 2,   # BTN_TR   R1
    310: 3,   # BTN_TL   L1
    307: 4,   # BTN_NORTH  Triangle / Y
    305: 5,   # BTN_EAST   Circle / B
    308: 6,   # BTN_WEST   Square / X
    304: 7,   # BTN_SOUTH  Cross / A
    314: 12,  # BTN_SELECT Create / View / Share
    316: 13,  # BTN_MODE   PS / Xbox / Steam
    315: 14,  # BTN_START  Options / Menu / Start
    317: 22,  # BTN_THUMBL L3
    318: 26,  # BTN_THUMBR R3
    544: 8, 545: 11, 546: 10, 547: 9,  # BTN_DPAD_UP/DOWN/LEFT/RIGHT (some drivers)
}
EVENT = struct.Struct("llHHi")  # timeval, type, code, value
ABSINFO = struct.Struct("6i")   # value, min, max, fuzz, flat, resolution


def _eviocgabs(code):
    # _IOR('E', 0x40 + code, struct input_absinfo)
    return (2 << 30) | (ABSINFO.size << 16) | (ord("E") << 8) | (0x40 + code)


def list_input_devices():
    """Every input device: name, event node, vendor, virtual or not, gamepad or not."""
    out = []
    try:
        text = open("/proc/bus/input/devices").read()
    except Exception:
        return out
    for block in text.strip().split("\n\n"):
        d = {"name": "", "sysfs": "", "handlers": "", "keys": "", "vendor": "", "product": ""}
        for line in block.splitlines():
            if line.startswith("I: "):
                for part in line[3:].split():
                    k, _, v = part.partition("=")
                    if k == "Vendor":
                        d["vendor"] = v.lower()
                    elif k == "Product":
                        d["product"] = v.lower()
            elif line.startswith("N: Name="):
                d["name"] = line.split("=", 1)[1].strip().strip('"')
            elif line.startswith("S: Sysfs="):
                d["sysfs"] = line.split("=", 1)[1].strip()
            elif line.startswith("H: Handlers="):
                d["handlers"] = line.split("=", 1)[1]
            elif line.startswith("B: KEY="):
                d["keys"] = line.split("=", 1)[1].strip()
        event = next((h for h in d["handlers"].split() if h.startswith("event")), None)
        bits = 0
        for i, w in enumerate(reversed(d["keys"].split())):
            bits |= int(w, 16) << (64 * i)
        out.append({
            "name": d["name"], "event": event, "vendor": d["vendor"], "product": d["product"],
            "virtual": d["sysfs"].startswith("/devices/virtual/"),
            "gamepad": bool((bits >> BTN_GAMEPAD) & 1),
        })
    return out


def find_gamepads():
    """
    [(event path, name)] for game controllers.

    Some SteamOS setups hand the real controller to an input service that
    hides it and re-creates it as a virtual device, so virtual gamepads count
    too, except Steam's own virtual pads (vendor 28de), which follow each
    game's Steam Input layout.
    """
    pads = [d for d in list_input_devices()
            if d["gamepad"] and d["event"] and not any(x in d["name"] for x in ("Motion Sensors", "Touchpad"))]
    # Both a physical pad and its re-created virtual copy may be read (one of
    # them can be grabbed and silent); the QAM ignores a duplicate press.
    chosen = [d for d in pads if not (d["virtual"] and d["vendor"] == "28de")]
    return [(f"/dev/input/{d['event']}", d["name"]) for d in chosen]


class Pad:
    def __init__(self, path, name):
        self.path, self.name = path, name
        self.fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
        self.keys = set()
        self.abs = {}
        self.ranges = {}
        for code in (ABS_Z, ABS_RZ, ABS_GAS, ABS_BRAKE, ABS_HAT0X, ABS_HAT0Y):
            try:
                buf = fcntl.ioctl(self.fd, _eviocgabs(code), bytes(ABSINFO.size))
                _, lo, hi, *_ = ABSINFO.unpack(buf)
                if hi > lo:
                    self.ranges[code] = (lo, hi)
            except OSError:
                pass
        self.mask = 0
        self.events = 0

    def trigger(self, *codes):
        for code in codes:
            if code in self.ranges and code in self.abs:
                lo, hi = self.ranges[code]
                if (self.abs[code] - lo) / (hi - lo) > 0.35:
                    return True
        return False

    def compute(self):
        m = 0
        for code in self.keys:
            b = KEY_BITS.get(code)
            if b is not None:
                m |= 1 << b
        if self.trigger(ABS_RZ, ABS_GAS):
            m |= 1 << 0
        if self.trigger(ABS_Z, ABS_BRAKE):
            m |= 1 << 1
        hx, hy = self.abs.get(ABS_HAT0X, 0), self.abs.get(ABS_HAT0Y, 0)
        if hy < 0: m |= 1 << 8
        if hx > 0: m |= 1 << 9
        if hx < 0: m |= 1 << 10
        if hy > 0: m |= 1 << 11
        return m

    def read(self):
        """Returns the new mask if it changed, else None."""
        changed = False
        try:
            data = os.read(self.fd, EVENT.size * 64)
        except BlockingIOError:
            return None
        for i in range(0, len(data) - EVENT.size + 1, EVENT.size):
            _, _, etype, code, value = EVENT.unpack_from(data, i)
            self.events += 1
            if etype == EV_KEY:
                if value:
                    self.keys.add(code)
                else:
                    self.keys.discard(code)
            elif etype == EV_ABS:
                self.abs[code] = value
            elif etype == EV_SYN and code == SYN_REPORT:
                m = self.compute()
                if m != self.mask:
                    self.mask = m
                    changed = True
        return self.mask if changed else None

    def close(self):
        try:
            os.close(self.fd)
        except OSError:
            pass


class Gamepads:
    """Watches every physical controller; calls on_change(path, name, mask)."""

    def __init__(self, on_change, logger):
        self.on_change = on_change
        self.log = logger
        self.pads = {}
        self.task = None
        self.wanted = False
        self.error = None

    @property
    def running(self):
        return self.task is not None and not self.task.done()

    def start(self):
        self.wanted = True
        if not self.running:
            self.task = asyncio.get_running_loop().create_task(self._run())

    def stop(self):
        self.wanted = False
        if self.task:
            self.task.cancel()
            self.task = None
        loop = asyncio.get_event_loop()
        for p in self.pads.values():
            try:
                loop.remove_reader(p.fd)
            except Exception:
                pass
            p.close()
        self.pads.clear()
        diag.log_external("[controller]", "stopped reading controllers")

    def info(self):
        return {"running": self.running, "error": self.error,
                "controllers": [{"name": p.name, "path": p.path, "events": p.events} for p in self.pads.values()],
                # Everything the system sees, for reports when a controller isn't picked up.
                "input_devices": [d for d in list_input_devices() if d["gamepad"] or "pad" in d["name"].lower()
                                  or "controller" in d["name"].lower() or "dualsense" in d["name"].lower()]}

    def _attach(self, path, name):
        try:
            pad = Pad(path, name)
        except OSError as e:
            self.error = f"can't open {name} ({path}): {e}"
            return
        loop = asyncio.get_running_loop()

        def readable(p=pad):
            try:
                m = p.read()
            except OSError:
                self._detach(p.path)
                return
            if m is not None:
                try:
                    self.on_change(p.path, p.name, m)
                except Exception:
                    pass

        loop.add_reader(pad.fd, readable)
        self.pads[path] = pad
        self.log.info(f"Controller shortcuts: reading {name} ({path})")

    def _detach(self, path):
        pad = self.pads.pop(path, None)
        if pad:
            try:
                asyncio.get_running_loop().remove_reader(pad.fd)
            except Exception:
                pass
            pad.close()
            self.log.info(f"Controller shortcuts: {pad.name} disconnected")

    async def _run(self):
        while self.wanted:
            found = dict(find_gamepads())
            for path in list(self.pads):
                if path not in found:
                    self._detach(path)
            for path, name in found.items():
                if path not in self.pads:
                    self._attach(path, name)
            names = ", ".join(p.name for p in self.pads.values())
            if self.pads:
                self.error = None
                diag.set("controller", diag.OK, f"reading {names}")
            else:
                diag.set("controller", diag.WARN, self.error or "no controller found (connect one, it's picked up automatically)")
            await asyncio.sleep(3)  # hotplug: controllers connecting / disconnecting
