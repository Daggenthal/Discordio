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

# gamescope overlays are X11 windows; never let GTK choose Wayland.
os.environ["GDK_BACKEND"] = "x11"
os.environ.pop("WAYLAND_DISPLAY", None)

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
SIZES = {"small": 0.8, "normal": 1.0, "large": 1.25}
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
    def __init__(self, on_ready):
        os.makedirs(CACHE_DIR, exist_ok=True)
        self.pixbufs = {}
        self.pending = set()
        self.failed = {}  # url -> time of last failure, for retry backoff
        # Called when a download finishes. Without it, an avatar that arrived
        # after the last state change stayed blank until something else
        # (like leaving and rejoining) forced a redraw.
        self.on_ready = on_ready

    def get(self, url, size):
        if not url:
            return None
        # gdk-pixbuf often lacks a WebP loader, so ask Discord's CDN for PNG.
        url = url.replace(".webp", ".png")
        key = (url, size)
        if key in self.pixbufs:
            return self.pixbufs[key]
        if url in self.failed and time.monotonic() - self.failed[url] < 10:
            return None
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
            self.failed[url] = time.monotonic()
            try:
                os.remove(path)  # don't keep a partial download
            except OSError:
                pass
            GLib.idle_add(self.on_ready)  # redraw so the retry is attempted
        finally:
            self.pending.discard(url)

    def _store(self, url, size, pb):
        self.pixbufs[(url, size)] = pb
        self.failed.pop(url, None)
        self.on_ready()
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
        self.state_time = time.monotonic()
        self.members = {}
        self.avatars = Avatars(self._avatar_ready)
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
        self.base_scale = self.scale
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

    def _avatar_ready(self):
        if getattr(self, "win", None):
            self.win.queue_draw()
        return False

    # -- data

    def poll(self):
        if self.avatars.failed:
            self.win.queue_draw()  # lets failed avatar downloads retry
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

    # -- stream picture-in-picture: the latest frame as a JPEG from the plugin

    def _pip_check(self, state):
        state = state or {}
        self.pip_state = state.get("pip")
        self.pip_fps = max(2, min(60, int((state.get("settings") or {}).get("pip_fps", 30) or 30)))
        if not self.pip_state:
            if getattr(self, "pip_pix", None) is not None:
                self.pip_pix = None
                self.pip_seq = None
                self.win.queue_draw()
            return
        if not getattr(self, "pip_running", False):
            self.pip_running = True
            threading.Thread(target=self._pip_loop, daemon=True).start()

    def _pip_loop(self):
        """Fetch frames at the chosen frame rate, independent of the state poll."""
        last = object()  # nothing shown yet
        try:
            while getattr(self, "pip_state", None):
                t0 = time.monotonic()
                try:
                    with urllib.request.urlopen(STATE_URL.rstrip("/") + "/pip.jpg", timeout=1) as r:
                        seq = r.headers.get("X-Seq")
                        body = r.read()
                    if seq is None or seq != last:
                        last = seq
                        loader = GdkPixbuf.PixbufLoader()
                        loader.write(body)
                        loader.close()
                        GLib.idle_add(self._pip_ready, seq, loader.get_pixbuf())
                except Exception:
                    time.sleep(0.2)
                time.sleep(max(0.0, 1.0 / getattr(self, "pip_fps", 30) - (time.monotonic() - t0)))
        finally:
            self.pip_running = False

    def _pip_ready(self, seq, pix):
        if pix is not None and getattr(self, "pip_state", None):
            self.pip_pix = pix
            self.pip_seq = seq
            self.win.queue_draw()
        return False

    def draw_pip(self, cr, state, settings):
        pix = getattr(self, "pip_pix", None)
        pip = state.get("pip")
        if pix is None or not pip:
            return
        s = self.scale
        # Fit inside a 16:9 box (380 x 214 at 100%), so a tall phone stream
        # doesn't fill the screen, scaled by the size setting (10-200 %).
        try:
            pct = max(10, min(300, int(settings.get("pip_size", 100)))) / 100
        except (TypeError, ValueError):
            pct = 1.0
        bw, bh = 380 * s * pct, 214 * s * pct
        aspect = pix.get_width() / max(1, pix.get_height())
        w = min(bw, bh * aspect)
        h = w / aspect
        pos = settings.get("pip_position", "bottom-right")
        x = MARGIN * s if "left" in pos else self.screen_w - w - MARGIN * s
        y = MARGIN * s if "top" in pos else self.screen_h - h - MARGIN * s
        cr.save()
        self.rounded(cr, x, y, w, h, 10 * s)
        cr.clip()
        cr.translate(x, y)
        cr.scale(w / pix.get_width(), h / pix.get_height())
        Gdk.cairo_set_source_pixbuf(cr, pix, 0, 0)
        cr.paint()
        cr.restore()
        # Who you're watching, bottom left of the picture.
        cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        cr.set_font_size(10 * s)
        tag_w = cr.text_extents("LIVE").x_advance + 10 * s
        self.tag(cr, "LIVE", x + 8 * s + tag_w, y + h - 24 * s, s, RED)
        if pip.get("name"):
            name_x = x + 8 * s + tag_w + 6 * s
            cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            cr.set_font_size(12 * s)
            cr.set_source_rgba(0, 0, 0, 0.6)
            self.text(cr, pip["name"], name_x + 1, y + h - 11 * s + 1, x + w - name_x - 8 * s)
            cr.set_source_rgba(1, 1, 1, 0.95)
            self.text(cr, pip["name"], name_x, y + h - 11 * s, x + w - name_x - 8 * s)

    def _apply(self, state):
        self.fetching = False
        try:
            self._pip_check(state)
        except Exception:
            pass
        self.state_time = time.monotonic()
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
        moving = bool((self.state or {}).get("messages"))  # fade in / out
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
        if not settings.get("overlay_enabled", True) or settings.get("overlay_engine_active", "gamescope") != "gamescope":
            return
        # Overlay options: size and opacity (whole overlay), and showing only
        # who's talking (the panel disappears when nobody is).
        self.scale = getattr(self, "base_scale", self.scale) * SIZES.get(settings.get("overlay_size"), 1.0)
        opacity = max(0.3, min(1.0, float(settings.get("overlay_opacity", 100)) / 100.0))
        if voice and settings.get("overlay_speakers_only"):
            talking = [m for m in voice.get("members", []) if m.get("speaking")]
            voice = {**voice, "members": talking} if talking else None
        cr.push_group()
        panel_h = self.draw_voice(cr, state, voice, settings) if voice else 0
        self.draw_messages(cr, state.get("messages") or [], settings, panel_h)
        self.draw_pip(cr, state, settings)
        cr.pop_group_to_source()
        cr.paint_with_alpha(opacity)

    def draw_voice(self, cr, state, voice, settings):
        """The voice panel. Returns its height (to stack message cards below it)."""
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
        return h

    # -- message popups

    def wrap(self, cr, text, max_w, max_lines):
        words, lines, cur = text.replace("\n", " ").split(" "), [], ""
        for word in words:
            trial = (cur + " " + word).strip()
            if cr.text_extents(trial).x_advance <= max_w:
                cur = trial
                continue
            if cur:
                lines.append(cur)
            cur = word
            while cr.text_extents(cur).x_advance > max_w and len(cur) > 1:  # very long word
                cut = len(cur)
                while cut > 1 and cr.text_extents(cur[:cut]).x_advance > max_w:
                    cut -= 1
                lines.append(cur[:cut])
                cur = cur[cut:]
            if len(lines) >= max_lines:
                break
        if cur and len(lines) < max_lines:
            lines.append(cur)
        if len(lines) == max_lines and " ".join(lines) != text.strip():
            last = lines[-1]
            while last and cr.text_extents(last + "...").x_advance > max_w:
                last = last[:-1]
            lines[-1] = last + "..."
        return lines

    def draw_messages(self, cr, messages, settings, panel_h):
        if not messages:
            return
        s = self.scale
        w = 320 * s
        pos = settings.get("message_position", "top-left")
        ttl = float(settings.get("message_duration", 8))
        share = panel_h and pos == settings.get("overlay_position", "top-left")
        x = MARGIN * s if "left" in pos else self.screen_w - w - MARGIN * s
        top = "top" in pos
        cursor = MARGIN * s + (panel_h + 10 * s if share else 0)
        for m in reversed(messages):  # newest nearest the edge
            cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            cr.set_font_size(13 * s)
            text_x = x + (12 + 36 + 10) * s
            text_w = w - (12 + 36 + 10 + 12) * s
            lines = self.wrap(cr, m.get("text") or "", text_w, 3)
            has_ctx = bool(m.get("context"))
            h = (10 + 17 + (14 if has_ctx else 0) + 17 * max(1, len(lines)) + 16 + 10) * s
            y = cursor if top else self.screen_h - cursor - h
            cursor += h + 8 * s

            age = float(m.get("age", 0)) + (time.monotonic() - self.state_time)
            fade_in = min(1.0, age / 0.25)
            fade_out = 1.0 if m.get("sticky") else min(1.0, max(0.0, (ttl - age) / 0.4))
            a = max(0.0, min(fade_in, fade_out))
            slide = (1 - fade_in) * -8 * s
            if a <= 0:
                continue
            yy = y + (slide if top else -slide)

            self.rounded(cr, x, yy, w, h, 10 * s)
            cr.set_source_rgba(0.07, 0.07, 0.08, 0.82 * a)
            cr.fill()
            cr.rectangle(x, yy + 6 * s, 3 * s, h - 12 * s)
            if m.get("kind") == "call":
                pulse = 0.55 + 0.45 * abs(math.sin(time.monotonic() * 3))  # ringing
                cr.set_source_rgba(0.137, 0.647, 0.353, a * pulse)
            else:
                cr.set_source_rgba(0.345, 0.396, 0.949, a)
            cr.fill()

            size = int(36 * s)
            ax, ay = x + 12 * s, yy + 10 * s
            cr.save()
            cr.new_path()
            cr.arc(ax + size / 2, ay + size / 2, size / 2, 0, 2 * math.pi)
            cr.clip()
            pb = self.avatars.get(m.get("avatar"), size)
            if pb:
                Gdk.cairo_set_source_pixbuf(cr, pb, ax, ay)
                cr.paint_with_alpha(a)
            else:
                cr.set_source_rgba(0.345, 0.396, 0.949, a)
                cr.paint()
            cr.restore()

            ty = yy + 10 * s + 13 * s
            cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            cr.set_font_size(13 * s)
            cr.set_source_rgba(1, 1, 1, a)
            self.text(cr, m.get("name", ""), text_x, ty, text_w)
            if has_ctx:
                ty += 14 * s
                cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
                cr.set_font_size(11 * s)
                cr.set_source_rgba(1, 1, 1, 0.6 * a)
                self.text(cr, m["context"], text_x, ty, text_w)
            cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            cr.set_font_size(13 * s)
            cr.set_source_rgba(1, 1, 1, 0.95 * a)
            for line in lines or [""]:
                ty += 17 * s
                cr.move_to(text_x, ty)
                cr.show_text(line)
            ty += 15 * s
            cr.set_font_size(10 * s)
            cr.set_source_rgba(1, 1, 1, 0.5 * a)
            self.text(cr, m.get("hint") or "Reply from Discordio in the Quick Access Menu", text_x, ty, text_w)

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


def die_with_parent():
    """Exit when the plugin backend exits, so no orphan keeps gamescope's overlay slot."""
    try:
        import signal
        ctypes.CDLL("libc.so.6").prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG
    except Exception:
        pass


def main():
    die_with_parent()
    try:
        Overlay()
    except Exception as e:
        log("failed to start:", f"{type(e).__name__}: {e}")
        sys.exit(2)
    Gtk.main()


if __name__ == "__main__":
    main()
