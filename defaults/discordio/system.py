"""Helpers for processes, users and ports on SteamOS."""

import os
import pwd
import signal
import socket
from pathlib import Path


def session_user(decky):
    """The logged-in Steam user (not necessarily "deck" on a Steam Machine)."""
    user = getattr(decky, "DECKY_USER", None) or os.environ.get("DECKY_USER") or "deck"
    try:
        info = pwd.getpwnam(user)
        return user, info.pw_uid, info.pw_dir
    except KeyError:
        return user, 1000, getattr(decky, "DECKY_USER_HOME", "/home/deck")


def user_env(decky):
    """Environment to reach the user's PipeWire / PulseAudio / D-Bus."""
    _, uid, home = session_user(decky)
    runtime = f"/run/user/{uid}"
    return {
        "XDG_RUNTIME_DIR": runtime,
        "DBUS_SESSION_BUS_ADDRESS": f"unix:path={runtime}/bus",
        "PULSE_SERVER": f"unix:{runtime}/pulse/native",
        "XDG_DATA_DIRS": f"{home}/.local/share/flatpak/exports/share:/var/lib/flatpak/exports/share:/usr/local/share:/usr/share",
        "HOME": home,
        "PATH": "/usr/bin:/bin",
    }


def steam_display(decky):
    """DISPLAY / XAUTHORITY of the running Steam client (gamescope's X server)."""
    _, uid, _ = session_user(decky)
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            if os.stat(f"/proc/{pid}").st_uid != uid:
                continue
            with open(f"/proc/{pid}/comm") as f:
                if f.read().strip() not in ("steam", "steamwebhelper"):
                    continue
            with open(f"/proc/{pid}/environ", "rb") as f:
                env = dict(kv.split(b"=", 1) for kv in f.read().split(b"\0") if b"=" in kv)
            if b"DISPLAY" in env:
                out = {"DISPLAY": env[b"DISPLAY"].decode()}
                if b"XAUTHORITY" in env:
                    out["XAUTHORITY"] = env[b"XAUTHORITY"].decode()
                return out
        except Exception:
            continue
    return {"DISPLAY": ":0"}


def process_running(name):
    for pid in os.listdir("/proc"):
        if pid.isdigit():
            try:
                with open(f"/proc/{pid}/comm") as f:
                    if f.read().strip() == name:
                        return True
            except Exception:
                pass
    return False


def python():
    for p in ("/usr/bin/python3", "/usr/bin/python"):
        if os.path.exists(p):
            return p
    return "python3"


def free_port(preferred=None):
    """The preferred port if free, otherwise any free loopback port."""
    for port in ([preferred] if preferred else []) + [0]:
        s = socket.socket()
        try:
            s.bind(("127.0.0.1", port))
            return s.getsockname()[1]
        except OSError:
            continue
        finally:
            s.close()
    raise RuntimeError("no free port")


def kill_stale(pidfile, script_name):
    """
    Kill a helper left over from a previous plugin run (it would keep its
    port and the gamescope overlay slot), then forget it.
    """
    pidfile = Path(pidfile)
    killed = False
    try:
        pid = int(pidfile.read_text().strip())
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            if script_name.encode() in f.read():
                os.kill(pid, signal.SIGTERM)
                killed = True
    except Exception:
        pass
    # Also catch helpers started by older versions, which had no pidfile.
    for pid in os.listdir("/proc"):
        if not pid.isdigit() or int(pid) == os.getpid():
            continue
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                cmd = f.read()
            if script_name.encode() in cmd and b"python" in cmd:
                os.kill(int(pid), signal.SIGTERM)
                killed = True
        except Exception:
            pass
    try:
        pidfile.unlink()
    except Exception:
        pass
    return killed
