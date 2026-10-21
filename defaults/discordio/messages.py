"""
Incoming Discord messages (DMs and mentions): recent conversations for the
QAM's Messages section, and the popups the overlay shows.
"""

import time

MAX_CONVERSATIONS = 30
MAX_POPUPS = 3


class Messages:
    def __init__(self, settings):
        self.settings = settings
        self.conversations = {}  # channel_id -> conversation
        self.popups = []         # newest last

    def add(self, m, popup=True):
        now = time.time()
        cid = m.get("channel_id")
        if not cid:
            return
        author = m.get("author") or {}
        if m.get("is_dm") and m.get("channel_label") in (None, "", "Direct message"):
            m = {**m, "channel_label": author.get("name") or "Direct message"}
        conv = self.conversations.get(cid) or {
            "channel_id": cid, "label": m.get("channel_label") or author.get("name") or "Message",
            "is_dm": bool(m.get("is_dm")), "avatar": author.get("avatar") if m.get("is_dm") else None, "unread": 0,
        }
        conv.update(
            label=m.get("channel_label") or conv["label"],
            last={"author": author.get("name"), "text": m.get("text", ""), "time": now},
            updated=now,
            unread=conv.get("unread", 0) + 1,
        )
        if m.get("is_dm") and author.get("avatar"):
            conv["avatar"] = author["avatar"]
        self.conversations[cid] = conv
        if len(self.conversations) > MAX_CONVERSATIONS:
            oldest = min(self.conversations.values(), key=lambda c: c["updated"])
            self.conversations.pop(oldest["channel_id"], None)

        if not popup:
            return
        self.popups.append({
            "id": m.get("id") or f"{cid}-{now}",
            "channel_id": cid,
            "name": author.get("name") or "Someone",
            "avatar": author.get("avatar"),
            "context": "" if m.get("is_dm") else (m.get("channel_label") or ""),
            "text": (m.get("text") or "")[:300],
            "shown_at": now,
        })
        del self.popups[:-MAX_POPUPS]

    def active_popups(self):
        s = self.settings.load()
        if not s.get("message_popups", True):
            return []
        ttl = int(s.get("message_duration", 8))
        now = time.time()
        self.popups = [p for p in self.popups if now - p["shown_at"] < ttl]
        return [{**p, "age": round(now - p["shown_at"], 2)} for p in self.popups]

    def list(self):
        return sorted(self.conversations.values(), key=lambda c: c["updated"], reverse=True)

    def mark_read(self, channel_id):
        if channel_id in self.conversations:
            self.conversations[channel_id]["unread"] = 0
        self.popups = [p for p in self.popups if p["channel_id"] != channel_id]

    def unread(self):
        return sum(c.get("unread", 0) for c in self.conversations.values())
