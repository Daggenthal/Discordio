"""Starts, supervises and talks to the capture helper (capture.py)."""

import asyncio
import base64
import time
from pathlib import Path

from aiohttp import ClientSession, ClientTimeout  # type: ignore

from . import diag, system

EXIT_SWITCH_LIBS = 75


class CaptureManager:
    def __init__(self, decky, plugin_dir, runtime_dir, settings, logger):
        self.decky = decky
        self.dir = Path(plugin_dir)
        self.runtime = Path(runtime_dir)
        self.settings = settings
        self.log = logger
        self.port = None
        self.proc = None
        self.lines = []
        self.status = None
        self.restarts = 0
        self.last_exit = None
        self.wake = asyncio.Event()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}"

    @property
    def running(self):
        return self.proc is not None and self.proc.returncode is None

    def _record(self, line):
        self.lines.append(f"{time.strftime('%H:%M:%S')} {line}")
        del self.lines[:-40]
        diag.log_external("[capture]", line)

    async def start(self):
        bundled = self.dir / "bin"
        s = self.settings.load()
        env = {
            **system.user_env(self.decky),
            "DISCORDIO_CAPTURE_PORT": str(self.port),
            "DISCORDIO_SETTINGS": str(self.settings.file),
            "DISCORDIO_BUNDLED_DIR": str(bundled),
            "PYTHONUNBUFFERED": "1",
        }
        # Bundled GStreamer by default when this build ships it; the helper
        # switches to SteamOS's own if that's what works (exit code 75).
        if bundled.exists() and s.get("capture_libs") != "system":
            env.update(LD_LIBRARY_PATH=str(bundled), GI_TYPELIB_PATH=str(bundled / "girepository-1.0"),
                       GST_PLUGIN_PATH=str(bundled / "gstreamer-1.0"), DISCORDIO_LIBS="bundled")
        else:
            env["DISCORDIO_LIBS"] = "system"
        self.proc = await asyncio.create_subprocess_exec(
            system.python(), str(self.dir / "capture.py"), env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        (self.runtime / "capture.pid").write_text(str(self.proc.pid))
        asyncio.get_running_loop().create_task(self._pump(self.proc))
        self.log.info(f"Capture helper started (pid {self.proc.pid}, port {self.port}, {env['DISCORDIO_LIBS']} GStreamer)")

    async def _pump(self, proc):
        async for raw in proc.stdout:
            line = raw.decode("utf-8", "replace").rstrip()
            if line:
                self._record(line)

    async def run(self):
        """Keep the helper running and its health reported. Never returns."""
        self.runtime.mkdir(parents=True, exist_ok=True)
        # Leftovers: our own helper from a previous run, or the old Deckcord-era
        # helper (gst_webrtc.py), which held the port in build 16.
        stale = system.kill_stale(self.runtime / "capture.pid", str(self.dir / "capture.py"))
        for old in ("Discordio/gst_webrtc.py", "Deckcord/gst_webrtc.py"):
            stale = system.kill_stale(self.runtime / "none.pid", old) or stale
        if stale:
            self.log.info("Stopped a capture helper left over from a previous run")
            await asyncio.sleep(0.5)
        self.port = system.free_port(65124)
        failures = 0
        while True:
            try:
                if not self.running:
                    if self.proc is not None:
                        code = self.proc.returncode
                        self.last_exit = code
                        if code == EXIT_SWITCH_LIBS:
                            self.log.info("Capture helper switching GStreamer libraries")
                            failures = 0
                        else:
                            failures += 1
                            last = self.lines[-1] if self.lines else "no output"
                            diag.set("capture", diag.ERROR, f"helper exited ({code}): {last}")
                            await asyncio.sleep(min(30, 2 * failures))
                    self.restarts += 1 if self.proc is not None else 0
                    self.port = system.free_port(self.port)
                    await self.start()
                    await asyncio.sleep(1.5)
                await self.refresh()
                if self.running:
                    failures = 0 if self.status else failures
            except asyncio.CancelledError:
                raise
            except Exception as e:
                diag.set("capture", diag.ERROR, f"manager: {e}")
            try:
                await asyncio.wait_for(self.wake.wait(), 3)
                self.wake.clear()
            except asyncio.TimeoutError:
                pass

    async def refresh(self):
        if not self.running:
            return
        try:
            async with ClientSession(timeout=ClientTimeout(total=3)) as s:
                async with s.get(f"{self.url}/status") as r:
                    self.status = await r.json()
        except Exception as e:
            self.status = None
            diag.set("capture", diag.WARN, f"helper not answering yet ({type(e).__name__})")
            return
        st = self.status
        if st.get("missing_elements"):
            diag.set("capture", diag.ERROR, "GStreamer is missing: " + ", ".join(st["missing_elements"]))
        elif not st.get("node"):
            seen = ", ".join(n["name"] for n in st.get("video_nodes") or []) or "none"
            diag.set("capture", diag.WARN, f"gamescope's video feed not found (video nodes: {seen})")
        elif st.get("probing"):
            diag.set("capture", diag.PENDING, st.get("probe_status") or "finding a capture method")
        elif st.get("stream") and st["stream"].get("running"):
            age = st["stream"].get("last_frame_age_s")
            if age is None or age > 5:
                diag.set("capture", diag.WARN, f"streaming but no frames for a while ({st['stream'].get('frames')} total)")
            else:
                diag.set("capture", diag.OK, f"streaming {st['stream'].get('preset')}, {st['stream'].get('frames')} frames")
        elif st.get("last_error"):
            diag.set("capture", diag.WARN, st["last_error"])
        elif st.get("method"):
            diag.set("capture", diag.OK, f"ready: {st['method']} via {st.get('method_libs')} GStreamer")
        else:
            diag.set("capture", diag.PENDING, "ready; capture method is found on the first preview")

    def restart(self):
        if self.running:
            self.proc.terminate()
        self.wake.set()

    def reset_method(self):
        self.settings.update(capture_variant="", capture_libs="bundled")
        self.restart()

    async def preview(self):
        if not self.running:
            self.wake.set()
            return {"error": "the capture helper is starting, try again in a moment"}
        try:
            async with ClientSession(timeout=ClientTimeout(total=9)) as s:
                async with s.get(f"{self.url}/preview") as r:
                    body = await r.read()
                    if r.status == 202:
                        return {"pending": body.decode("utf-8", "replace")[:300]}
                    if r.status != 200:
                        return {"error": body.decode("utf-8", "replace")[:300] or f"HTTP {r.status}"}
                    return {"image": "data:image/jpeg;base64," + base64.b64encode(body).decode()}
        except asyncio.TimeoutError:
            return {"error": "the capture helper didn't answer within 9s"}
        except Exception as e:
            return {"error": f"capture helper unreachable: {type(e).__name__}: {e}"}

    async def stop(self):
        if self.running:
            self.proc.terminate()
            try:
                await asyncio.wait_for(self.proc.wait(), 3)
            except asyncio.TimeoutError:
                self.proc.kill()
