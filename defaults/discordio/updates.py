"""
Update check against Discordio's GitHub releases.

Channels:
  stable  releases marked as full releases (a tested build, promoted with the
          "Promote a build to stable" workflow or by unticking "pre-release")
  beta    every build CI publishes (pre-releases), newest first
The QAM hands the zip to Decky's own installer, which reloads the plugin in
place, so updating never needs Desktop Mode or a Decky restart.
"""

import re

from aiohttp import ClientSession, ClientTimeout  # type: ignore

from . import diag
from .vencord import ssl_context

# GitHub lists releases with the "latest" one first, then by tag name as
# text, so build-100 sorts below build-99 and fell outside a short list.
# Ask for a full page, pick the highest build number, then look a few build
# numbers further directly (one small request each, normally just one).
RELEASES_API = "https://api.github.com/repos/Daggenthal/Discordio/releases?per_page=100"
TAG_API = "https://api.github.com/repos/Daggenthal/Discordio/releases/tags/build-{n}"


def build_number(version):
    """CI builds are 0.1.0-build.42, tags are build-42; local builds have none."""
    m = re.search(r"build[.-](\d+)", version or "")
    return int(m.group(1)) if m else 0


async def check(current, channel="stable"):
    channel = "beta" if channel == "beta" else "stable"
    info = {"current": current, "current_build": build_number(current), "available": False, "channel": channel}
    try:
        async with ClientSession(timeout=ClientTimeout(total=15)) as s:
            async with s.get(RELEASES_API, ssl=ssl_context(),
                             headers={"Accept": "application/vnd.github+json", "User-Agent": "Discordio"}) as r:
                if r.status != 200:
                    info["error"] = f"GitHub returned HTTP {r.status}"
                    diag.set("updates", diag.WARN, info["error"])
                    return info
                releases = await r.json()
            # Newer builds than the highest one listed, if any.
            listed = max((build_number(x.get("tag_name", "")) for x in releases), default=0)
            n = listed
            for _ in range(10):
                n += 1
                async with s.get(TAG_API.format(n=n), ssl=ssl_context(),
                                 headers={"Accept": "application/vnd.github+json", "User-Agent": "Discordio"}) as t:
                    if t.status != 200:
                        break
                    releases.append(await t.json())
    except Exception as e:
        info["error"] = f"{type(e).__name__}: {e}"
        diag.set("updates", diag.WARN, f"couldn't check: {info['error']}")
        return info

    best = None
    for rel in releases:
        if rel.get("draft"):
            continue
        if channel == "stable" and rel.get("prerelease"):
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
    if not best and channel == "stable":
        info["note"] = "no stable release yet; the beta channel has the latest builds"
    diag.set("updates", diag.OK,
             f"build {info['current_build'] or 'local'} ({channel})"
             + (f", build {info.get('latest_build')} available" if info["available"] else ", up to date"))
    return info
