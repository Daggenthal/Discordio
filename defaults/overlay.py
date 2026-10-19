"""
Discordio in-game overlay.

A transparent, click-through window that gamescope draws on top of games, the
same mechanism MangoHud's mangoapp uses (the GAMESCOPE_EXTERNAL_OVERLAY window
property). It polls the plugin backend for the current voice channel and draws
who is in it, who is talking, and mute / deafen / LIVE state.

Speaking: the avatar gets a green ring, does a small hop, and stays raised
while the person talks. When they stop it drops back down and fades a little
(still visible).

Run by main.py with DISPLAY / XAUTHORITY taken from the Steam session.
"""

import ctypes
import ctypes.util
import hashlib
import json
import math
import os
import sys
import threading
import time
import urllib.request

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import Gdk, GdkPixbuf, GLib, Gtk  # noqa: E402
import cairo  # noqa: E402

STATE_URL = os.environ.get("DISCORDIO_OVERLAY_URL", "http://127.0.0.1:65123/overlay")
CACHE_DIR = os.environ.get("DISCORDIO_CACHE", "/tmp/discordio-overlay")
POLL_MS = 100
FRAME_MS = 16

# Look (sizes are for 1080p and scale with the screen).
PAD = 10
ROW_H = 36
AVATAR = 28
WIDTH = 270
MARGIN = 24
LIFT = 4.0           # how far a speaker stays raised, px
HOP = 260.0          # initial upward speed of the hop, px/s
SPRING = 420.0       # spring stiffness pulling to the target height
DAMPING = 18.0
IDLE_ALPHA = 0.55    # "faded but still visible"
GREEN = (0.137, 0.647, 0.353)
RED = (0.929, 0.259, 0.271)


def log(*a):
    print("[overlay]", *a, flush=True)


# ---------------------------------------------------------------- X11 helper

def mark_as_gamescope_overlay(xid):
    """Set GAMESCOPE_EXTERNAL_OVERLAY=1 on our window through a plain Xlib call."""
    libx11 = ctypes.CDLL(ctypes.util.find_library("X11") or "libX11.so.6")
    libx11.XOpenDisplay.restype = ctypes.c_void_p
    libx11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    libx11.XInternAtom.restype = ctypes.c_ulong
    libx11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    libx11.XChangeProperty.argtypes = [
        ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong,
        ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_int,
    ]
    libx11.XFlush.argtypes = [ctypes.c_void_p]
    libx11.XCloseDisplay.argtypes = [ctypes.c_void_p]

    dpy = libx11.XOpenDisplay(None)
    if not dpy:
        raise RuntimeError("XOpenDisplay failed for DISPLAY=%s" % os.environ.get("DISPLAY"))
    atom = libx11.XInternAtom(dpy, b"GAMESCOPE_EXTERNAL_OVERLAY", 0)
    XA_CARDINAL = 6
    value = ctypes.c_long(1)  # format-32 properties are passed as longs
    libx11.XChangeProperty(dpy, xid, atom, XA_CARDINAL, 32, 0, ctypes.byref(value), 1)
    libx11.XFlush(dpy)
    libx11.XCloseDisplay(dpy)


# ---------------------------------------------------------------- avatars

class Avatars:
    def __init__(self):
        os.makedirs(CACHE_DIR, exist_ok=True)
        self.pixbufs = {}
        self.pending = set()

    def get(self, url, size):
        if not url:
            return None
        # gdk-pixbuf often lacks a WebP loader, so ask Discord's CDN for PNG.
        url = url.replace(".webp", ".png")
        key = (url, size)
        if key in self.pixbufs:
            return self.pixbufs[key]
        if url not in self.pending:
            self.pending.add(url)
            threading.Thread(target=self._fetch, args=(url, size), daemon=True).start()
        return None

    def _fetch(self, url, size):
        path = os.path.join(CACHE_DIR, hashlib.sha1(url.encode()).hexdigest() + ".png")
        try:
            if not os.path.exists(path):
                req = urllib.request.Request(url, headers={"User-Agent": "Discordio"})
                with urllib.request.urlopen(req, timeout=10) as r, open(path, "wb") as f:
                    f.write(r.read())
            pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, size, size, True)
            GLib.idle_add(self._store, url, size, pb)
        except Exception as e:
            log("avatar failed:", url, e)
        finally:
            self.pending.discard(url)

    def _store(self, url, size, pb):
        self.pixbufs[(url, size)] = pb
        return False


# ---------------------------------------------------------------- overlay

class Member:
    def __init__(self, data):
        self.y = 0.0
        self.vy = 0.0
        self.alpha = IDLE_ALPHA
        self.speaking = False
        self.update(data)

    def update(self, data):
        self.data = data
        speaking = bool(data.get("speaking"))
        if speaking and not self.speaking:
            self.vy = -HOP  # the little hop
        self.speaking = speaking

    def step(self, dt):
        target = -LIFT if self.speaking else 0.0
        self.vy += (target - self.y) * SPRING * dt
        self.vy *= math.exp(-DAMPING * dt)
        self.y += self.vy * dt
        a_target = 1.0 if self.speaking else IDLE_ALPHA
        self.alpha += (a_target - self.alpha) * min(1.0, dt * 10)
        # Still moving?
        return abs(self.vy) > 1 or abs(self.y - target) > 0.2 or abs(self.alpha - a_target) > 0.01


class Overlay:
    def __init__(self):
        self.state = None
        self.members = {}
        self.avatars = Avatars()
        self.animating = False
        self.last_frame = time.monotonic()
        self.fetching = False

        win = Gtk.Window(type=Gtk.WindowType.POPUP)
        screen = win.get_screen()
        visual = screen.get_rgba_visual()
        if visual is None:
            raise RuntimeError("No RGBA visual, the overlay cannot be transparent here")
        win.set_visual(visual)
        win.set_app_paintable(True)
        win.set_accept_focus(False)
        win.set_keep_above(True)

        display = Gdk.Display.get_default()
        monitor = display.get_primary_monitor() or display.get_monitor(0)
        g = monitor.get_geometry()
        self.screen_w, self.screen_h = g.width, g.height
        self.scale = max(0.75, g.height / 1080.0)
        win.move(g.x, g.y)
        win.resize(g.width, g.height)
        win.connect("draw", self.draw)
        win.realize()

        gdkwin = win.get_window()
        # Click-through: an empty input region means all input goes to the game.
        gdkwin.input_shape_combine_region(cairo.Region(), 0, 0)
        mark_as_gamescope_overlay(gdkwin.get_xid())
        win.show_all()
        self.win = win
        log(f"running on {os.environ.get('DISPLAY')} at {g.width}x{g.height}, scale {self.scale:.2f}")

        GLib.timeout_add(POLL_MS, self.poll)

    # -- data

    def poll(self):
        if not self.fetching:
            self.fetching = True
            threading.Thread(target=self._fetch_state, daemon=True).start()
        return True

    def _fetch_state(self):
        try:
            with urllib.request.urlopen(STATE_URL, timeout=1) as r:
                state = json.loads(r.read())
        except Exception:
            state = None
        GLib.idle_add(self._apply, state)

    def _apply(self, state):
        self.fetching = False
        old = json.dumps(self.state, sort_keys=True) if self.state else None
        self.state = state
        voice = (state or {}).get("voice")
        ids = set()
        for m in (voice or {}).get("members", []):
            ids.add(m["id"])
            if m["id"] in self.members:
                self.members[m["id"]].update(m)
            else:
                self.members[m["id"]] = Member(m)
        for gone in set(self.members) - ids:
            del self.members[gone]
        # Only redraw when something changed; animation frames handle the rest.
        if json.dumps(state, sort_keys=True) != old:
            self.kick()
        return False

    # -- animation

    def kick(self):
        if not self.animating:
            self.animating = True
            self.last_frame = time.monotonic()
            GLib.timeout_add(FRAME_MS, self.frame)
        self.win.queue_draw()

    def frame(self):
        now = time.monotonic()
        dt = min(0.05, now - self.last_frame)
        self.last_frame = now
        moving = False
        for m in self.members.values():
            moving = m.step(dt) or moving
        self.win.queue_draw()
        if not moving:
            self.animating = False
            return False
        return True

    # -- drawing

    def draw(self, widget, cr):
        cr.set_operator(cairo.OPERATOR_SOURCE)
        cr.set_source_rgba(0, 0, 0, 0)
        cr.paint()
        cr.set_operator(cairo.OPERATOR_OVER)

        state = self.state or {}
        voice = state.get("voice")
        settings = state.get("settings") or {}
        if not voice or not settings.get("overlay_enabled", True):
            return

        s = self.scale
        members = voice.get("members", [])
        w = WIDTH * s
        header_h = 44 * s
        h = header_h + len(members) * ROW_H * s + PAD * s
        pos = settings.get("overlay_position", "top-left")
        x = MARGIN * s if "left" in pos else self.screen_w - w - MARGIN * s
        y = MARGIN * s if "top" in pos else self.screen_h - h - MARGIN * s

        # Panel
        self.rounded(cr, x, y, w, h, 10 * s)
        cr.set_source_rgba(0.07, 0.07, 0.08, 0.62)
        cr.fill()

        # Header: channel, server, LIVE
        cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        cr.set_font_size(14 * s)
        cr.set_source_rgba(1, 1, 1, 0.95)
        right = x + w - PAD * s
        me = state.get("me") or {}
        if me.get("live"):
            right = self.tag(cr, "LIVE", right, y + 9 * s, s, RED) - 6 * s
        self.text(cr, voice.get("channel_name", "Voice"), x + PAD * s, y + 20 * s, right - x - PAD * s)
        cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
        cr.set_font_size(11 * s)
        cr.set_source_rgba(1, 1, 1, 0.6)
        self.text(cr, voice.get("guild_name", ""), x + PAD * s, y + 36 * s, w - 2 * PAD * s)

        # Members
        ry = y + header_h
        for data in members:
            m = self.members.get(data["id"])
            off = (m.y if m else 0) * s
            alpha = m.alpha if m else IDLE_ALPHA
            self.member_row(cr, data, x + PAD * s, ry, w - 2 * PAD * s, off, alpha, s)
            ry += ROW_H * s

    def member_row(self, cr, m, x, y, w, off, alpha, s):
        size = int(AVATAR * s)
        ax, ay = x, y + (ROW_H * s - size) / 2 + off
        cx, cy, r = ax + size / 2, ay + size / 2, size / 2

        # Speaking ring
        if m.get("speaking"):
            cr.new_path()  # don't connect to the last text position
            cr.arc(cx, cy, r + 2.5 * s, 0, 2 * math.pi)
            cr.set_source_rgba(*GREEN, 1)
            cr.set_line_width(2.5 * s)
            cr.stroke()

        # Avatar, clipped to a circle
        cr.save()
        cr.new_path()
        cr.arc(cx, cy, r, 0, 2 * math.pi)
        cr.clip()
        pb = self.avatars.get(m.get("avatar"), size)
        if pb:
            Gdk.cairo_set_source_pixbuf(cr, pb, ax, ay)
            cr.paint_with_alpha(alpha)
        else:
            cr.set_source_rgba(0.345, 0.396, 0.949, alpha)
            cr.paint()
        cr.restore()

        # Status tags on the right
        right = x + w
        cy_tag = y + (ROW_H * s - 16 * s) / 2
        if m.get("live"):
            right = self.tag(cr, "LIVE", right, cy_tag, s, RED) - 4 * s
        if m.get("deafened"):
            right = self.tag(cr, "DEAF", right, cy_tag, s, RED, filled=False) - 4 * s
        elif m.get("muted"):
            right = self.mic_off(cr, right, y + ROW_H * s / 2, s) - 4 * s

        # Name
        cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL,
                            cairo.FONT_WEIGHT_BOLD if m.get("speaking") else cairo.FONT_WEIGHT_NORMAL)
        cr.set_font_size(13 * s)
        cr.set_source_rgba(1, 1, 1, max(alpha, 0.7))
        nx = ax + size + 8 * s
        self.text(cr, m.get("name", ""), nx, y + ROW_H * s / 2 + 4.5 * s + off * 0.5, right - nx - 4 * s)

    # -- primitives

    @staticmethod
    def rounded(cr, x, y, w, h, r):
        cr.new_sub_path()
        cr.arc(x + w - r, y + r, r, -math.pi / 2, 0)
        cr.arc(x + w - r, y + h - r, r, 0, math.pi / 2)
        cr.arc(x + r, y + h - r, r, math.pi / 2, math.pi)
        cr.arc(x + r, y + r, r, math.pi, 3 * math.pi / 2)
        cr.close_path()

    @staticmethod
    def text(cr, s, x, y, max_w):
        if max_w <= 0:
            return
        if cr.text_extents(s).x_advance > max_w:
            while s and cr.text_extents(s + "...").x_advance > max_w:
                s = s[:-1]
            s += "..."
        cr.move_to(x, y)
        cr.show_text(s)

    def tag(self, cr, label, right, y, s, color, filled=True):
        cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        cr.set_font_size(10 * s)
        tw = cr.text_extents(label).x_advance
        w, h = tw + 10 * s, 16 * s
        x = right - w
        self.rounded(cr, x, y, w, h, 4 * s)
        if filled:
            cr.set_source_rgba(*color, 1)
            cr.fill()
            cr.set_source_rgba(1, 1, 1, 1)
        else:
            cr.set_source_rgba(*color, 1)
            cr.set_line_width(1.5 * s)
            cr.stroke()
        cr.move_to(x + 5 * s, y + 12 * s)
        cr.show_text(label)
        return x

    @staticmethod
    def mic_off(cr, right, cy, s):
        """A small microphone with a slash through it."""
        w = 14 * s
        x = right - w
        cx = x + w / 2
        cr.set_source_rgba(*RED, 1)
        cr.set_line_width(1.8 * s)
        cr.new_path()
        # capsule
        Overlay.rounded(cr, cx - 3 * s, cy - 7 * s, 6 * s, 10 * s, 3 * s)
        cr.stroke()
        # stand
        cr.new_path()
        cr.arc(cx, cy - 1 * s, 5.5 * s, 0, math.pi)
        cr.stroke()
        cr.move_to(cx, cy + 4.5 * s)
        cr.line_to(cx, cy + 7 * s)
        cr.stroke()
        # slash
        cr.move_to(cx - 6 * s, cy - 7 * s)
        cr.line_to(cx + 6 * s, cy + 7 * s)
        cr.stroke()
        return x


def main():
    try:
        Overlay()
    except Exception as e:
        log("failed to start:", f"{type(e).__name__}: {e}")
        sys.exit(2)
    Gtk.main()


if __name__ == "__main__":
    main()
