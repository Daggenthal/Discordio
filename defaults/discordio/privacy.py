"""
"Hide Usernames" for screenshots: friends' and servers' names are swapped for
made-up ones before they reach the Quick Access Menu or the overlay. The same
real name always gets the same stand-in, so everything stays consistent.
Nothing is changed in Discord itself.
"""

import re

ADJ = ["Sunny", "Quiet", "Brave", "Lucky", "Swift", "Cozy", "Bright", "Calm", "Clever", "Gentle", "Happy", "Jolly",
       "Mellow", "Nimble", "Plucky", "Rapid", "Shy", "Sleepy", "Snappy", "Witty", "Bold", "Breezy", "Fuzzy", "Zesty"]
ANIMALS = ["Otter", "Fox", "Panda", "Falcon", "Koala", "Badger", "Heron", "Lynx", "Moose", "Owl", "Puffin", "Raven",
           "Seal", "Tiger", "Wombat", "Yak", "Bison", "Gecko", "Hare", "Lemur", "Marten", "Newt", "Quokka", "Sparrow"]
PLACES = ["Hangout", "Lounge", "Corner", "Clubhouse", "Hideout", "Den", "Arcade", "Cafe", "Garage", "Workshop",
          "Basement", "Treehouse", "Harbor", "Station", "Outpost", "Tavern"]

_on = False


def set_enabled(v):
    global _on
    _on = bool(v)


def enabled():
    return _on


def _hash(s):
    h = 2166136261
    for ch in str(s).encode():
        h = ((h ^ ch) * 16777619) & 0xFFFFFFFF
    return h


def person(name):
    if not name:
        return name
    h = _hash("p:" + name)
    return f"{ADJ[h % len(ADJ)]} {ANIMALS[(h // 97) % len(ANIMALS)]}"


def server(name):
    if not name:
        return name
    h = _hash("s:" + name)
    return f"{ADJ[(h // 7) % len(ADJ)]} {PLACES[(h // 131) % len(PLACES)]}"


_CHAN_IN = re.compile(r"^(#[^ ]+) in (.+)$")
_CHAN_PAREN = re.compile(r"^(#[^(]+) \((.+)\)$")
_CHAN_DOT = re.compile(r"^(#.+) · (.+)$")


def channel_label(label, is_dm=None):
    """'#general in Server' / '#general (Server)' -> server swapped; a DM's
    label (people's names) -> made-up names."""
    if not label:
        return label
    for rx, fmt in ((_CHAN_IN, "{} in {}"), (_CHAN_PAREN, "{} ({})"), (_CHAN_DOT, "{} · {}")):
        m = rx.match(label)
        if m:
            return fmt.format(m.group(1), server(m.group(2)))
    if label.startswith("#") or label == "Direct message":
        return label
    if is_dm is False:
        return label
    return ", ".join(person(n.strip()) for n in label.split(","))


def _member(m):
    if isinstance(m, dict) and m.get("name"):
        m["name"] = person(m["name"])
    return m


def friends(lst):
    for f in lst or []:
        if isinstance(f, dict):
            f["name"] = person(f.get("name"))
            v = f.get("voice")
            if isinstance(v, dict) and v.get("guild_name"):
                v["guild_name"] = server(v["guild_name"])
    return lst


def guilds(lst):
    for g in lst or []:
        if isinstance(g, dict):
            g["name"] = server(g.get("name"))
    return lst


def voice(v):
    if isinstance(v, dict):
        if v.get("guild_name"):
            v["guild_name"] = server(v["guild_name"])
        if v.get("channel_name") and not v.get("guild_id"):
            # A DM call's "channel" is the other person's name.
            v["channel_name"] = channel_label(v["channel_name"])
        for m in v.get("members") or v.get("users") or []:
            if not (isinstance(m, dict) and v.get("me") and m.get("id") == v.get("me")):
                _member(m)
    return v


def voice_channels(lst):
    for ch in lst or []:
        for m in (ch or {}).get("members") or []:
            _member(m)
    return lst


def conversations(res):
    for c in (res or {}).get("conversations") or []:
        c["label"] = channel_label(c.get("label"), c.get("is_dm"))
        last = c.get("last")
        if isinstance(last, dict) and last.get("author"):
            last["author"] = person(last["author"])
    return res


def history(h):
    if not isinstance(h, dict):
        return h
    h["label"] = channel_label(h.get("label"))
    for m in h.get("messages") or []:
        if not m.get("mine"):  # your own name stays
            _member(m.get("author"))
        r = m.get("replyTo")
        if isinstance(r, dict) and r.get("name"):
            r["name"] = person(r["name"])
    h["typing"] = [person(t) for t in h.get("typing") or []]
    return h


def profile(p):
    if not isinstance(p, dict) or p.get("me"):
        return p
    p["name"] = person(p.get("name"))
    p["username"] = None
    p["note"] = None
    for c in p.get("connections") or []:
        c["name"] = "Hidden"
    return p


def requests(r):
    for k in ("incoming", "outgoing"):
        for x in (r or {}).get(k) or []:
            x["name"] = person(x.get("name"))
            x["username"] = None
    return r


def call(c):
    if isinstance(c, dict):
        _member(c.get("caller"))
        if c.get("group"):
            c["group"] = channel_label(c["group"])
    return c


def popups(lst):
    for p in lst or []:
        if p.get("kind") == "call" or p.get("channel_id"):
            p["name"] = person(p.get("name"))
            if p.get("context"):
                p["context"] = channel_label(p["context"], False) if p["context"].startswith("#") else server(p["context"])
    return lst
