"""
Update check against the GitHub pre-releases CI publishes for every build.
The QAM hands the zip to Decky's own installer, which reloads the plugin in
place, so updating never needs Desktop Mode or a Decky restart.
"""

import re

from aiohttp import ClientSession, ClientTimeout  # type: ignore

from . import diag
from .vencord import ssl_context

RELEASES_API = "https://api.github.com/repos/Daggenthal/Discordio/releases?per_page=20"


def build_number(version):
    """CI builds are 0.1.0-build.42, tags are build-42; local builds have none."""
    m = re.search(r"build[.-](\d+)", version or "")
    return int(m.group(1)) if m else 0


async def check(current):
    info = {"current": current, "current_build": build_number(current), "available": False}
    try:
        async with ClientSession(timeout=ClientTimeout(total=15)) as s:
            async with s.get(RELEASES_API, ssl=ssl_context(),
                             headers={"Accept": "application/vnd.github+json", "User-Agent": "Discordio"}) as r:
                if r.status != 200:
                    info["error"] = f"GitHub returned HTTP {r.status}"
                    diag.set("updates", diag.WARN, info["error"])
                    return info
                releases = await r.json()
    except Exception as e:
        info["error"] = f"{type(e).__name__}: {e}"
        diag.set("updates", diag.WARN, f"couldn't check: {info['error']}")
        return info

    best = None
    for rel in releases:
        if rel.get("draft"):
            continue
        n = build_number(rel.get("tag_name", ""))
        asset = next((a for a in rel.get("assets", []) if a.get("name", "").endswith(".zip")), None)
        if n and asset and (best is None or n > best[0]):
            best = (n, rel, asset)
    if best:
        n, rel, asset = best
        info.update(latest=rel.get("name") or rel.get("tag_name"), latest_build=n, version=f"build.{n}",
                    url=asset["browser_download_url"], notes=(rel.get("body") or "")[:400],
                    available=n > info["current_build"])
    diag.set("updates", diag.OK,
             f"build {info['current_build'] or 'local'}" + (f", build {info.get('latest_build')} available" if info["available"] else ", up to date"))
    return info
