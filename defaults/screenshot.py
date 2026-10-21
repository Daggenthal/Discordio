"""
Experimental: capture the whole screen as gamescope shows it, Quick Access
Menu and overlays included (Steam's own screenshots only keep the game).

gamescope takes a screenshot when the GAMESCOPECTRL_REQUEST_SCREENSHOT
property is set on the root window of its X server (that's how Steam asks
for one), writing /tmp/gamescope_<time>.png. The property's value picks
what goes in it; we ask for everything on screen.

  screenshot.py OUT_DIR COUNT FPS [TYPES]

COUNT 1 is one screenshot; more is a sequence of frames (frame_0001.png...)
to turn into a GIF. Prints a JSON result on the last line.
"""

import ctypes
import ctypes.util
import glob
import json
import os
import shutil
import sys
import time

# gamescope_control screenshot types: 0 base plane (the game), 1 all real
# layers, 2 full composition, 3 the screen buffer (exactly what's shown).
DEFAULT_TYPES = [3, 2, 1]


def x11():
    lib = ctypes.CDLL(ctypes.util.find_library("X11") or "libX11.so.6")
    lib.XOpenDisplay.restype = ctypes.c_void_p
    lib.XOpenDisplay.argtypes = [ctypes.c_char_p]
    lib.XDefaultRootWindow.restype = ctypes.c_ulong
    lib.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    lib.XInternAtom.restype = ctypes.c_ulong
    lib.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    lib.XChangeProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong,
                                    ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
    lib.XFlush.argtypes = [ctypes.c_void_p]
    lib.XCloseDisplay.argtypes = [ctypes.c_void_p]
    return lib


def request(lib, dpy, root, kind):
    atom = lib.XInternAtom(dpy, b"GAMESCOPECTRL_REQUEST_SCREENSHOT", 0)
    value = ctypes.c_long(kind)
    lib.XChangeProperty(dpy, root, atom, 6, 32, 0, ctypes.byref(value), 1)  # XA_CARDINAL, replace
    lib.XFlush(dpy)


def wait_new(since, timeout):
    end = time.time() + timeout
    while time.time() < end:
        files = [f for f in glob.glob("/tmp/gamescope_*.png") if os.path.getmtime(f) >= since]
        if files:
            f = max(files, key=os.path.getmtime)
            # Wait until gamescope has finished writing it.
            size = -1
            for _ in range(20):
                s = os.path.getsize(f)
                if s and s == size:
                    return f
                size = s
                time.sleep(0.1)
            return f
        time.sleep(0.05)
    return None


def main():
    out_dir, count, fps = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
    types = [int(t) for t in sys.argv[4].split(",")] if len(sys.argv) > 4 else DEFAULT_TYPES
    os.makedirs(out_dir, exist_ok=True)
    lib = x11()
    dpy = lib.XOpenDisplay(None)
    if not dpy:
        print(json.dumps({"error": f"can't open the X display {os.environ.get('DISPLAY')}"}))
        return
    root = lib.XDefaultRootWindow(dpy)

    # Find a screenshot type this gamescope answers to.
    kind, first = None, None
    for t in types:
        since = time.time() - 0.05
        request(lib, dpy, root, t)
        first = wait_new(since, 4)
        if first:
            kind = t
            break
    if not first:
        lib.XCloseDisplay(dpy)
        print(json.dumps({"error": "gamescope didn't take a screenshot (no /tmp/gamescope_*.png appeared)"}))
        return

    files = []
    name = (lambda i: f"frame_{i:04d}.png") if count > 1 else (lambda i: time.strftime("discordio-ui-%Y%m%d-%H%M%S.png"))
    dest = os.path.join(out_dir, name(1))
    shutil.move(first, dest)
    files.append(dest)
    interval = 1.0 / max(0.5, fps)
    for i in range(2, count + 1):
        t0 = time.time()
        request(lib, dpy, root, kind)
        f = wait_new(t0 - 0.05, 3)
        if f:
            dest = os.path.join(out_dir, name(i))
            shutil.move(f, dest)
            files.append(dest)
        time.sleep(max(0.0, interval - (time.time() - t0)))
    lib.XCloseDisplay(dpy)
    print(json.dumps({"ok": True, "type": kind, "files": files, "dir": out_dir}))


if __name__ == "__main__":
    main()
