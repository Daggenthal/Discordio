import { call, toaster } from "@decky/api";
import { ButtonItem, PanelSectionRow, ToggleField } from "@decky/ui";
import { useEffect, useState } from "react";
import { note } from "../../lib/diag";
import { ChoiceSlider } from "../ChoiceSlider";

// A controller shortcut for the microphone: press it to toggle mute (the
// default), or hold it to talk (push to talk).
//
// It reads Steam's raw controller state, which reports every button on any
// controller (Steam Machine pads, Xbox, DualSense, Deck). The old version
// listened to Steam Input *action* messages, which ordinary buttons never
// send, so learning a button never worked. A combination of buttons can be
// learned too, so the shortcut doesn't clash with the game's own controls.

type Mode = "mute" | "ptt";
type Shortcut = { enabled: boolean; mode: Mode; mask: string };
const KEY = "DISCORDIO_MIC_SHORTCUT";

// Bits in Steam's controller state (low word, then ulUpperButtons + 64).
const NAMES: Record<number, string> = {
  0: "RT", 1: "LT", 2: "RB", 3: "LB", 4: "Y", 5: "B", 6: "X", 7: "A",
  8: "D-pad up", 9: "D-pad right", 10: "D-pad left", 11: "D-pad down",
  12: "View", 13: "Steam", 14: "Menu", 15: "L5", 16: "R5", 17: "Left pad click", 18: "Right pad click",
  22: "L3", 26: "R3",
  [64 + 9]: "L4", [64 + 10]: "R4", [64 + 18]: "Quick access",
};
// Touching a trackpad or the sticks' capacitive sensors isn't a press.
const IGNORED = [19, 20, 23, 24, 25, 27, 28, 29, 30, 31].reduce((m, b) => m | (1n << BigInt(b)), 0n);

const load = (): Shortcut => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "null");
    if (v && typeof v.mask === "string") return { enabled: !!v.enabled, mode: v.mode === "ptt" ? "ptt" : "mute", mask: v.mask };
  } catch (_) {}
  return { enabled: false, mode: "mute", mask: "0" };
};
const save = (s: Shortcut) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch (_) {}
};

const toBig = (n: any) => {
  try {
    return BigInt(Math.trunc(Number(n) || 0));
  } catch (_) {
    return 0n;
  }
};
const pressedOf = (c: any) => ((toBig(c.ulButtons) | (toBig(c.ulUpperButtons) << 64n)) & ~IGNORED);

export const describeMask = (mask: string) => {
  const m = BigInt(mask || "0");
  if (!m) return "not set";
  const parts: string[] = [];
  for (let b = 0; b < 128; b++) if (m & (1n << BigInt(b))) parts.push(NAMES[b] ?? `button ${b}`);
  return parts.join(" + ");
};

// ------------------------------------------------------------ module state
// Lives outside React so the shortcut keeps working with the QAM closed.
let settings = load();
let unregister: (() => void) | undefined;
const prev = new Map<number, bigint>();
let active = false; // shortcut currently held (for push to talk)
let learn: { union: bigint; armed: boolean; done: (mask: bigint) => void } | null = null;
let lastEvent = 0;
let listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => fn());

function onStates(changes: any[]) {
  lastEvent = Date.now();
  for (const c of changes || []) {
    const idx = c.unControllerIndex ?? 0;
    const now = pressedOf(c);
    const before = prev.get(idx) ?? 0n;
    if (now === before) continue;
    prev.set(idx, now);

    if (learn) {
      // Wait until everything is released (the A press that started
      // learning), then collect buttons until they're all let go again.
      if (!learn.armed) {
        if (now === 0n) learn.armed = true;
        continue;
      }
      learn.union |= now;
      if (now === 0n && learn.union) {
        const l = learn;
        learn = null;
        l.done(l.union);
      }
      changed();
      continue;
    }

    if (!settings.enabled) continue;
    const want = BigInt(settings.mask || "0");
    if (!want) continue;
    const isDown = (now & want) === want;
    const wasDown = (before & want) === want;
    if (isDown === wasDown) continue;
    if (settings.mode === "mute") {
      if (isDown) call("toggle_mute").catch(() => {});
    } else if (isDown !== active) {
      active = isDown;
      call("set_ptt", isDown).catch(() => {});
    }
  }
}

function ensureListening() {
  if (unregister) return;
  try {
    const input = (window as any).SteamClient?.Input;
    if (!input?.RegisterForControllerStateChanges) throw new Error("Steam has no controller state API here");
    const r = input.RegisterForControllerStateChanges(onStates);
    unregister = () => r?.unregister?.();
    note("Controller shortcut", true, "listening to controller buttons");
  } catch (e) {
    note("Controller shortcut", false, String(e));
  }
}

function stopIfIdle() {
  if (!settings.enabled && !learn && unregister) {
    try {
      unregister();
    } catch (_) {}
    unregister = undefined;
  }
}

function apply(next: Shortcut) {
  const modeChanged = next.mode !== settings.mode || next.enabled !== settings.enabled;
  settings = next;
  save(next);
  if (modeChanged) {
    // Discord's push-to-talk mode only while that's what the shortcut does.
    call("enable_ptt", next.enabled && next.mode === "ptt").catch(() => {});
    if (active) {
      active = false;
      call("set_ptt", false).catch(() => {});
    }
  }
  if (next.enabled) ensureListening();
  else stopIfIdle();
  changed();
}

// Called once when the plugin loads.
export function startMicShortcut() {
  if (settings.enabled && BigInt(settings.mask || "0")) {
    ensureListening();
    if (settings.mode === "ptt") call("enable_ptt", true).catch(() => {});
  }
}

export const cleanupPtt = () => {
  learn = null;
  if (unregister) {
    try {
      unregister();
    } catch (_) {}
    unregister = undefined;
  }
};

const MODES = [
  { value: "mute", short: "Toggle mute", label: "Press to mute / unmute" },
  { value: "ptt", short: "Push to talk", label: "Hold to talk" },
];

export function PushToTalkButton() {
  const [, force] = useState(0);
  const [learning, setLearning] = useState(false);
  const [preview, setPreview] = useState("");

  useEffect(() => {
    const fn = () => {
      force((n) => n + 1);
      if (learn) setPreview(describeMask(learn.union.toString()));
    };
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  const s = settings;
  const hasButton = BigInt(s.mask || "0") !== 0n;

  const startLearning = () => {
    ensureListening();
    setLearning(true);
    setPreview("");
    const startedAt = Date.now();
    learn = {
      union: 0n,
      armed: false,
      done: (mask) => {
        setLearning(false);
        apply({ ...settings, mask: mask.toString(), enabled: true });
        toaster.toast({ title: "Discordio", body: `Mic button: ${describeMask(mask.toString())}` });
      },
    };
    // Tell the user if no controller input arrives at all.
    setTimeout(() => {
      if (learn && lastEvent < startedAt) {
        learn = null;
        setLearning(false);
        stopIfIdle();
        toaster.toast({ title: "Discordio", body: "No controller input reached Discordio. See Diagnostics." });
        note("Controller shortcut", false, "no controller state updates arrived while learning");
      }
    }, 8000);
  };

  return (
    <>
      <PanelSectionRow>
        <ToggleField
          label="Mic button"
          description={hasButton ? `${describeMask(s.mask)}: ${s.mode === "mute" ? "press to mute / unmute" : "hold to talk"}` : "Choose a controller button first"}
          checked={s.enabled && hasButton}
          disabled={!hasButton}
          onChange={(v) => apply({ ...s, enabled: v })}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ChoiceSlider label="Mic button does" choices={MODES} value={s.mode} onChange={(v) => apply({ ...s, mode: v as Mode })} />
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem
          layout="below"
          disabled={learning}
          description={
            learning
              ? "Press and hold the button (or buttons together), then let go"
              : "A combination like View + R3 won't clash with your games"
          }
          onClick={startLearning}
        >
          {learning ? (preview ? `Got: ${preview}` : "Waiting for a button...") : hasButton ? "Change mic button" : "Choose mic button"}
        </ButtonItem>
      </PanelSectionRow>
    </>
  );
}
