"""
Diagnostics registry.

Every part of the plugin reports its health here (ok / warn / error / off,
with a short detail), problems go into a ring buffer of recent errors, and a
log handler keeps the last few hundred log lines. The QAM's Diagnostics
section and the exported report both read from this one place.
"""

import logging
import time
from collections import deque

OK, WARN, ERROR, OFF, PENDING = "ok", "warn", "error", "off", "pending"

# Display order in the QAM.
COMPONENTS = [
    ("steam_ui", "Steam UI connection"),
    ("discord_view", "Discord view"),
    ("vencord", "Vencord"),
    ("bridge", "Discord bridge"),
    ("account", "Discord account"),
    ("mic", "Microphone bridge"),
    ("call", "Call connection"),
    ("controller", "Controller shortcuts"),
    ("capture", "Screen capture"),
    ("overlay", "In-game overlay"),
    ("updates", "Updates"),
]

_status = {}
_errors = deque(maxlen=60)
_log = deque(maxlen=400)
_listeners = []


def set(component, state, detail="", **extra):
    """Report a component's health. Errors also land in the recent-errors list."""
    prev = _status.get(component)
    entry = {"state": state, "detail": detail, "since": time.time(), **extra}
    if prev and prev["state"] == state and prev["detail"] == detail:
        entry["since"] = prev["since"]
    _status[component] = entry
    if state == ERROR and (not prev or prev["state"] != ERROR or prev["detail"] != detail):
        error(component, detail)
    if not prev or prev["state"] != state or prev["detail"] != detail:
        for fn in list(_listeners):
            try:
                fn()
            except Exception:
                pass


def get(component):
    return _status.get(component)


def error(component, message):
    _errors.append({"time": time.time(), "component": component, "message": str(message)[:500]})


def on_change(fn):
    _listeners.append(fn)


def snapshot():
    names = dict(COMPONENTS)
    comps = []
    for key, label in COMPONENTS:
        s = _status.get(key) or {"state": PENDING, "detail": "not started yet", "since": time.time()}
        comps.append({"key": key, "label": label, **s})
    for key, s in _status.items():
        if key not in names:
            comps.append({"key": key, "label": key, **s})
    return {
        "components": comps,
        "errors": list(_errors)[-20:][::-1],
    }


def _append(created, body):
    """
    Add a log line. A line repeating one of the last few (a crash loop, say)
    bumps a counter on it instead, so it can't push everything else out.
    """
    for entry in list(_log)[-4:]:
        if entry[1] == body:
            entry[2] += 1
            entry[3] = created
            return
    _log.append([created, body, 1, created])


def log_lines(n=200):
    out = []
    for first, body, count, last in list(_log)[-n:]:
        line = f"{time.strftime('%H:%M:%S', time.localtime(first))} {body}"
        if count > 1:
            line += f"  (x{count}, last {time.strftime('%H:%M:%S', time.localtime(last))})"
        out.append(line)
    return out


class _RingHandler(logging.Handler):
    def emit(self, record):
        try:
            _append(record.created, f"{record.levelname[0]} {self.format(record)}")
        except Exception:
            pass


def install_log_handler(logger):
    h = _RingHandler()
    h.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(h)


def log_external(prefix, line):
    """Lines from child processes (capture helper, overlay)."""
    _append(time.time(), f"{prefix} {line}")


# ------------------------------------------------------------------ privacy
# Diagnostics and reports get shared when asking for help, so by default
# they hide who you are and who you talk to: names seen while running
# (you, friends, callers, message authors, servers, channels) and every
# Discord ID (and the avatar / attachment links that contain them).
import json as _json
import re as _re

import builtins as _builtins
_private = _builtins.set()
_SNOWFLAKE = _re.compile(r"(?<![\d.])\d{17,20}(?![\d.])")


def remember_private(*names):
    for n in names:
        if isinstance(n, str):
            n = n.strip()
            if len(n) >= 2 and not n.isdigit() and n.lower() not in _NOT_PRIVATE:
                _private.add(n)


# Words that also appear as names but are part of Discordio's own text.
_NOT_PRIVATE = {"voice", "general", "direct message", "direct call", "message", "someone", "unknown"}


def redact_text(text):
    if not isinstance(text, str) or not text:
        return text
    for name in sorted(_private, key=len, reverse=True):
        if name in text:
            # Whole words only, so a short name doesn't eat parts of words.
            text = _re.sub(r"(?<!\w)" + _re.escape(name) + r"(?!\w)", "<name>", text)
    return _SNOWFLAKE.sub("<id>", text)


def redact(value):
    """Redact a str / dict / list (anything JSON-like), returning a copy."""
    if isinstance(value, str):
        return redact_text(value)
    try:
        return _json.loads(redact_text(_json.dumps(value, default=str)))
    except Exception:
        return value
