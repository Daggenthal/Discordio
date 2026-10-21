"""
In-game overlay engines.

gamescope composites only ONE external overlay, and Steam's performance
overlay (MangoHud's mangoapp) uses it. So there are two engines:

  gamescope  overlay.py, an external overlay window (smoothest)
  steam      overlay_web.js, drawn inside Steam's own overlay window

During a call the plugin hides the performance overlay (the QAM does
that through Steam, see src/lib/perfOverlay.ts) and puts the user's level
back afterwards, so the gamescope overlay always has the slot. Outside
calls, the Steam layer is used while the performance overlay is showing.
"""

import asyncio
import time
from pathlib import Path

from . import cdp, diag, system

STEAM_LAYER_TABS = ("notificationtoasts",)


class OverlayManager:
    def __init__(self, decky, plugin_dir, runtime_dir, settings, state_url, logger):
        self.decky = decky
        self.dir = Path(plugin_dir)
        self.runtime = Path(runtime_dir)
        self.settings = settings
        self.state_url = state_url
        self.log = logger
        self.proc = None
        self.last_line = ""
        self.retry_at = 0.0
        self.failures = 0
        self.steam_tabs = set()
        self.status = "starting"
        self.perf = (None, "not checked yet")
        self.call_active = lambda: False  # set by the plugin: ringing or in a call
        self.started_at = 0.0
        self.hold = False  # performance overlay held off for a call
        self.hold_since = 0.0

    def enabled(self, s=None):
        """On, or off but turned on for the call that's ringing / in progress."""
        s = s or self.settings.load()
        if s.get("overlay_enabled", True):
            return True
        try:
            return bool(s.get("overlay_calls", True) and self.call_active())
        except Exception:
            return False

    def wants_hold(self, s=None):
        """A call is ringing or in progress and the overlay is showing for it."""
        s = s or self.settings.load()
        if not s.get("overlay_hide_perf", True):
            return False
        try:
            return bool(self.enabled(s) and self.call_active())
        except Exception:
            return False

    def active_engine(self, s=None):
        s = s or self.settings.load()
        if not self.enabled(s):
            return None
        visible, _ = self.perf
        if visible is None:  # couldn't tell: the old rule, mangoapp running at all
            visible = system.process_running("mangoapp")
        if self.hold:
            # The performance overlay is off for the call: gamescope's slot is ours.
            return "gamescope"
        # gamescope shows one external overlay; while the performance
        # overlay has it, draw inside Steam's overlay instead.
        return "steam" if visible else "gamescope"

    # --- hiding the performance overlay during a call
    #
    # Steam shows / hides the performance overlay by rewriting MangoHud's
    # config file, which mangoapp watches. Hiding it the same way (and
    # putting the file back afterwards) works whatever Steam's internal
    # settings API looks like on this build.

    HIDE = "no_display\n"

    def _saved_path(self):
        return self.runtime / "mangohud-saved.conf"

    def _hide_perf(self):
        path = system.mangohud_config_path()
        if not path:
            return "mangoapp isn't running"
        p = Path(path)
        try:
            current = p.read_text()
        except Exception as e:
            return f"can't read {path}: {e}"
        lines = [l.strip() for l in current.splitlines()]
        if not any(lines) or "no_display" in lines:
            return "already off"
        self.runtime.mkdir(parents=True, exist_ok=True)
        self._saved_path().write_text(f"{path}\n{current}")
        p.write_text(self.HIDE)
        return "hidden"

    def _restore_perf(self):
        saved = self._saved_path()
        if not saved.exists():
            return "nothing to restore"
        try:
            path, _, content = saved.read_text().partition("\n")
            p = Path(path)
            # Only if it's still the way we left it: if you (or Steam)
            # changed the performance overlay during the call, that wins.
            if p.exists() and p.read_text() == self.HIDE:
                p.write_text(content)
                result = "restored"
            else:
                result = "changed during the call, left as is"
        except Exception as e:
            result = f"couldn't restore: {e}"
        try:
            saved.unlink()
        except Exception:
            pass
        return result

    async def _update_hold(self, s=None):
        hold = self.wants_hold(s)
        if hold == self.hold:
            return
        self.hold = hold
        self.hold_since = time.monotonic()
        try:
            result = self._hide_perf() if hold else self._restore_perf()
            diag.set("perf_hold", diag.OK, f"call {'started' if hold else 'ended'}: performance overlay {result}")
        except Exception as e:
            diag.set("perf_hold", diag.WARN, f"couldn't change the performance overlay: {e}")
        self.perf = system.perf_overlay_state()
        self.log.info("call %s: %s Steam's performance overlay", "started" if hold else "ended",
                      "hiding" if hold else "restoring")
        try:
            await self.decky.emit("perf_hold", {"hold": hold})
        except Exception as e:
            self.log.warning(f"perf_hold event failed: {e}")

    @property
    def running(self):
        return self.proc is not None and self.proc.returncode is None

    async def run(self):
        system.kill_stale(self.runtime / "overlay.pid", str(self.dir / "overlay.py"))
        # A call that was in progress when the plugin stopped: give it back.
        try:
            if self._saved_path().exists():
                self.log.info("performance overlay: %s", self._restore_perf())
        except Exception:
            pass
        asyncio.get_running_loop().create_task(self._steam_layer())
        while True:
            try:
                self.perf = system.perf_overlay_state()
                await self._update_hold()
                active = self.active_engine()
                if active == "gamescope":
                    if not self.running and time.monotonic() >= self.retry_at:
                        await self._start()
                elif self.running:
                    await self.stop()  # frees gamescope's slot, e.g. for the FPS overlay
                if self.proc is not None and self.proc.returncode is not None:
                    code = self.proc.returncode
                    self.proc = None
                    if code not in (0, -15) and active == "gamescope":
                        self.failures += 1
                        self.retry_at = time.monotonic() + min(60, 3 * self.failures)
                        self.status = f"stopped (exit {code}): {self.last_line[-160:]}"
                self._report(active)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.status = f"error: {e}"
                diag.set("overlay", diag.ERROR, self.status)
            await asyncio.sleep(1)

    def _report(self, active):
        if active is None:
            self.status = "off"
            diag.set("overlay", diag.OFF, "turned off")
        elif active == "steam":
            self.status = (f"running in Steam's overlay ({len(self.steam_tabs)} window)" if self.steam_tabs
                           else "waiting for Steam's overlay window")
            diag.set("overlay", diag.OK if self.steam_tabs else diag.PENDING, f"Steam layer: {self.status}")
        elif self.running:
            if time.monotonic() - self.started_at > 10:
                self.failures = 0  # only once it has stayed up, or a crash loop never backs off
            diag.set("overlay", diag.OK, f"gamescope engine: {self.status}")
        else:
            diag.set("overlay", diag.ERROR if self.failures else diag.PENDING, f"gamescope engine: {self.status}")

    async def _start(self):
        env = {
            **system.user_env(self.decky),
            **system.steam_display(self.decky),
            "DISCORDIO_CACHE": str(self.runtime / "avatars"),
            "DISCORDIO_OVERLAY_URL": self.state_url,
            "PYTHONUNBUFFERED": "1",
        }
        # gamescope's overlay slot is an X11 window property; GTK must not pick
        # Wayland even when the session exports WAYLAND_DISPLAY.
        env["GDK_BACKEND"] = "x11"
        env.pop("WAYLAND_DISPLAY", None)
        self.started_at = time.monotonic()
        self.proc = await asyncio.create_subprocess_exec(
            system.python(), str(self.dir / "overlay.py"), env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        (self.runtime / "overlay.pid").write_text(str(self.proc.pid))
        self.status = f"running on {env['DISPLAY']}"
        self.log.info(f"Overlay started on DISPLAY={env['DISPLAY']}")

        async def pump(proc):
            async for raw in proc.stdout:
                line = raw.decode("utf-8", "replace").rstrip()
                if line:
                    self.last_line = line
                    diag.log_external("[overlay]", line)

        asyncio.get_running_loop().create_task(pump(self.proc))

    async def stop(self):
        if self.running:
            self.proc.terminate()
            try:
                await asyncio.wait_for(self.proc.wait(), 3)
            except asyncio.TimeoutError:
                self.proc.kill()

    async def _steam_layer(self):
        script = None
        stop = "window.__discordioOverlayStop ? window.__discordioOverlayStop() : 'not running'"
        while True:
            try:
                if script is None:
                    script = (self.dir / "overlay_web.js").read_text().replace(
                        "http://127.0.0.1:65123/overlay", self.state_url)
                want = self.active_engine() == "steam"
                injected = set()
                for info in await cdp.list_targets():
                    if not info.get("title", "").lower().startswith(STEAM_LAYER_TABS):
                        continue
                    t = cdp.Target(info)
                    try:
                        await t.connect()
                        if want:
                            await t.evaluate(script, timeout=5)
                            injected.add(t.title)
                        elif t.title in self.steam_tabs:
                            await t.evaluate(stop, timeout=5)
                    except Exception as e:
                        self.log.warning(f"Steam-layer overlay on {t.title}: {e}")
                    finally:
                        await t.close()
                self.steam_tabs = injected if want else set()
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            await asyncio.sleep(3)

    def info(self):
        s = self.settings.load()
        return {"enabled": s.get("overlay_enabled", True), "position": s.get("overlay_position", "top-left"),
                "engine": s.get("overlay_engine", "auto"), "active": self.active_engine(s), "status": self.status,
                "perf_overlay": self.perf[1], "calls": s.get("overlay_calls", True),
                "size": s.get("overlay_size", "normal"), "opacity": s.get("overlay_opacity", 100),
                "speakers_only": bool(s.get("overlay_speakers_only", False)), "hold": self.hold,
                "hide_perf": bool(s.get("overlay_hide_perf", True))}
