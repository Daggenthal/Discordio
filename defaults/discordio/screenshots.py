"""
Steam screenshots on disk, for picking which one to send.

Steam keeps them under userdata/<account>/760/remote/<appid>/screenshots/,
with small thumbnails in a thumbnails/ folder next to them.
"""

import base64
import hashlib
from pathlib import Path


class Screenshots:
    def __init__(self, home):
        self.home = Path(home)
        self.by_id = {}

    def _roots(self):
        seen, roots = set(), []
        for r in (self.home / ".local/share/Steam/userdata", self.home / ".steam/steam/userdata",
                  self.home / ".steam/root/userdata"):
            try:
                real = r.resolve()
            except Exception:
                continue
            if real.is_dir() and real not in seen:
                seen.add(real)
                roots.append(real)
        return roots

    def _scan(self):
        files = []
        for root in self._roots():
            for shots in root.glob("*/760/remote/*/screenshots"):
                appid = shots.parent.name
                for f in shots.iterdir():
                    if f.suffix.lower() in (".jpg", ".jpeg", ".png") and f.is_file():
                        try:
                            files.append((f.stat().st_mtime, appid, f))
                        except OSError:
                            pass
        files.sort(key=lambda x: x[0], reverse=True)
        return files

    def list(self, offset=0, limit=12):
        files = self._scan()
        out = []
        for mtime, appid, f in files[offset:offset + limit]:
            sid = hashlib.sha1(str(f).encode()).hexdigest()[:16]
            self.by_id[sid] = f
            thumb = f.parent / "thumbnails" / f.name
            out.append({
                "id": sid,
                "appid": int(appid) if appid.isdigit() else 0,
                "time": mtime,
                "thumb": self._data_url(thumb) if thumb.exists() and thumb.stat().st_size < 400_000 else None,
            })
        return {"items": out, "total": len(files)}

    def path(self, sid):
        """Only ids handed out by list() resolve, so nothing else on disk can be read."""
        return self.by_id.get(sid)

    def data_url(self, sid):
        p = self.path(sid)
        return self._data_url(p) if p else None

    @staticmethod
    def _data_url(p):
        mime = "image/png" if p.suffix.lower() == ".png" else "image/jpeg"
        return f"data:{mime};base64," + base64.b64encode(p.read_bytes()).decode()

    def base64(self, sid):
        p = self.path(sid)
        if not p:
            return None, None
        return base64.b64encode(p.read_bytes()).decode(), p.name
