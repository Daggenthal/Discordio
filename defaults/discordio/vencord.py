"""
Vencord download with an on-disk cache.

Discordio's page scripts use Vencord's webpack helpers to reach Discord's
internal stores. A cached copy means a network hiccup at boot doesn't break
everything, and the diagnostics show where it came from.
"""

import os
import ssl
from pathlib import Path

from aiohttp import ClientSession, ClientTimeout  # type: ignore

from . import diag

URL = "https://raw.githubusercontent.com/Vencord/builds/main/browser.js"


def ssl_context():
    for cafile in ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"):
        if os.path.exists(cafile):
            return ssl.create_default_context(cafile=cafile)
    return ssl.create_default_context()


async def load(cache_dir):
    cache = Path(cache_dir) / "vencord-browser.js"
    error = None
    try:
        async with ClientSession(timeout=ClientTimeout(total=20)) as s:
            async with s.get(URL, ssl=ssl_context()) as r:
                if r.status == 200:
                    text = await r.text()
                    try:
                        cache.parent.mkdir(parents=True, exist_ok=True)
                        cache.write_text(text)
                    except Exception:
                        pass
                    diag.set("vencord", diag.OK, f"downloaded ({len(text) // 1024} KB)")
                    return text
                error = f"HTTP {r.status}"
    except Exception as e:
        error = f"{type(e).__name__}: {e}"

    if cache.exists():
        text = cache.read_text()
        diag.set("vencord", diag.WARN, f"download failed ({error}), using cached copy")
        return text
    diag.set("vencord", diag.ERROR, f"download failed ({error}) and no cached copy")
    raise RuntimeError(f"Could not download Vencord: {error}")
