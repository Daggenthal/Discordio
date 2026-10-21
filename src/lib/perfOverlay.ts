import { addEventListener, call, removeEventListener } from "@decky/api";

// Steam's performance overlay (FPS etc.) and Discordio's overlay can't both
// show through gamescope. During a call Discordio turns the performance
// overlay off, remembers the level you had, and puts it back when the call
// ends. Done through Steam's own setting, so the Performance tab stays in sync.

const SAVED = "DISCORDIO_PERF_LEVEL_SAVED";
const HIDDEN = 0; // EGraphicsPerfOverlayLevel: Hidden 0, Basic 1, Medium 2, Full 3, Minimal 4

let level: number | null = null; // current level, from Steam's perf state
let unregister: (() => void) | null = null;

const perf = () => (window as any).SteamClient?.System?.Perf;
const log = (ok: boolean, detail: string): void => {
  call("perf_hold_log", ok, detail).catch(() => {});
};

const getSaved = (): number | null => {
  try {
    const v = localStorage.getItem(SAVED);
    return v == null ? null : Number(v);
  } catch (_) {
    return null;
  }
};
const setSaved = (v: number | null) => {
  try {
    if (v == null) localStorage.removeItem(SAVED);
    else localStorage.setItem(SAVED, String(v));
  } catch (_) {}
};

// --- minimal protobuf reading: CMsgSystemPerfState.settings(2).global(1).perf_overlay_level(5)
function varint(b: Uint8Array, i: number): [number, number] {
  let r = 0, shift = 0;
  while (i < b.length) {
    const x = b[i++];
    r += (x & 0x7f) * 2 ** shift;
    if (!(x & 0x80)) break;
    shift += 7;
  }
  return [r, i];
}
function field(b: Uint8Array, want: number): Uint8Array | number | null {
  let i = 0;
  while (i < b.length) {
    let key: number;
    [key, i] = varint(b, i);
    const num = Math.floor(key / 8), wire = key & 7;
    if (wire === 0) {
      let v: number;
      [v, i] = varint(b, i);
      if (num === want) return v;
    } else if (wire === 2) {
      let len: number;
      [len, i] = varint(b, i);
      if (num === want) return b.subarray(i, i + len);
      i += len;
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else return null;
  }
  return null;
}
function levelFromState(buf: ArrayBuffer): number | null {
  const settings = field(new Uint8Array(buf), 2);
  if (!(settings instanceof Uint8Array)) return null;
  const global = field(settings, 1);
  if (!(global instanceof Uint8Array)) return null;
  const lv = field(global, 5);
  return typeof lv === "number" ? lv : HIDDEN; // proto default: field absent = 0 (hidden)
}

// CMsgSystemPerfSettings { global(1) { perf_overlay_level(5) } }, as Steam's
// Performance tab sends it.
function setLevel(n: number) {
  const bytes = String.fromCharCode(0x0a, 0x02, 0x28, n & 0x7f);
  perf().UpdateSettings(btoa(bytes));
  level = n;
}

function apply(hold: boolean): void {
  try {
    if (!perf()?.UpdateSettings) {
      log(false, "Steam's performance settings API isn't available");
      return;
    }
    if (hold) {
      if (getSaved() == null && level != null && level !== HIDDEN) {
        setSaved(level);
        setLevel(HIDDEN);
        log(true, `call: performance overlay hidden (was level ${getSaved()})`);
      } else if (level == null) log(false, "couldn't read the performance overlay level");
      else log(true, "call: performance overlay already off");
    } else {
      const saved = getSaved();
      if (saved == null) return;
      setSaved(null);
      // Only if still off: if you changed it during the call, yours wins.
      if (level === HIDDEN || level == null) {
        setLevel(saved);
        log(true, `call ended: performance overlay restored to level ${saved}`);
      } else log(true, "call ended: you changed the performance overlay during the call, left as is");
    }
  } catch (e) {
    log(false, `couldn't change the performance overlay: ${e}`);
  }
}

const onHold = (d: any) => apply(!!d?.hold);

// Called once when the plugin loads.
export function startPerfOverlayHold() {
  try {
    const r = perf()?.RegisterForStateChanges?.((buf: ArrayBuffer) => {
      try {
        const lv = levelFromState(buf);
        if (lv != null) level = lv;
      } catch (_) {}
    });
    unregister = () => r?.unregister?.();
  } catch (e) {
    log(false, `can't watch the performance overlay: ${e}`);
  }
  addEventListener("perf_hold", onHold);
  // Catch up: a call in progress, or one that ended while the plugin was away.
  setTimeout(() => {
    call<[], boolean>("get_perf_hold")
      .then((hold) => apply(!!hold))
      .catch(() => {});
  }, 1500);
  return () => {
    removeEventListener("perf_hold", onHold);
    // Unloading (e.g. updating) mid-call: give the overlay back now.
    const saved = getSaved();
    if (saved != null && (level === HIDDEN || level == null)) {
      try {
        setLevel(saved);
      } catch (_) {}
      setSaved(null);
    }
    try {
      unregister?.();
    } catch (_) {}
  };
}
