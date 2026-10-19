import { call, toaster } from "@decky/api";
import { note } from "./diag";

// Controller shortcuts, read from Steam's raw controller state: every
// physical button on any controller (DualSense, Xbox, Steam Controller,
// Deck), the same whatever the game's Steam Input layout is.
//
//   mic      press: toggle mute (or hold: push to talk)
//   answer   while a call is ringing (default: hold Options/Start + R2)
//   decline  while a call is ringing (default: hold Options/Start + L2)

export type Action = "mic" | "answer" | "decline";
export type MicMode = "mute" | "ptt";
export type Bindings = {
  mic: { enabled: boolean; mode: MicMode; mask: string };
  answer: { enabled: boolean; mask: string };
  decline: { enabled: boolean; mask: string };
};

const KEY = "DISCORDIO_SHORTCUTS";
const OLD_MIC_KEY = "DISCORDIO_MIC_SHORTCUT";

// Bits in Steam's controller state (low word, then ulUpperButtons + 64).
// Names follow Xbox / Steam labels with PlayStation names alongside.
const B = { RT: 0, LT: 1, RB: 2, LB: 3, Y: 4, B: 5, X: 6, A: 7, UP: 8, RIGHT: 9, LEFT: 10, DOWN: 11, VIEW: 12, STEAM: 13, MENU: 14 };
const NAMES: Record<number, string> = {
  0: "R2", 1: "L2", 2: "R1", 3: "L1", 4: "Triangle/Y", 5: "Circle/B", 6: "Square/X", 7: "Cross/A",
  8: "D-pad up", 9: "D-pad right", 10: "D-pad left", 11: "D-pad down",
  12: "Create/View", 13: "PS/Steam", 14: "Options/Start", 15: "L5", 16: "R5", 17: "Left pad click", 18: "Right pad click",
  22: "L3", 26: "R3",
  [64 + 9]: "L4", [64 + 10]: "R4", [64 + 18]: "Quick access",
};
const bit = (n: number) => 1n << BigInt(n);
// Touching a trackpad / capacitive stick isn't a press.
const IGNORED = [19, 20, 23, 24, 25, 27, 28, 29, 30, 31].reduce((m, b) => m | bit(b), 0n);
// Analog triggers count as pressed past this point, so R2 / L2 work even
// on pads that don't set the digital "fully pulled" bit.
const TRIGGER_PRESS = 12000; // of 32767

export const DEFAULTS: Bindings = {
  mic: { enabled: false, mode: "mute", mask: "0" },
  answer: { enabled: true, mask: String(bit(B.MENU) | bit(B.RT)) },
  decline: { enabled: true, mask: String(bit(B.MENU) | bit(B.LT)) },
};

function load(): Bindings {
  let out: Bindings = JSON.parse(JSON.stringify(DEFAULTS));
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "null");
    if (v) out = { mic: { ...out.mic, ...v.mic }, answer: { ...out.answer, ...v.answer }, decline: { ...out.decline, ...v.decline } };
    else {
      // Earlier builds kept only the mic button.
      const old = JSON.parse(localStorage.getItem(OLD_MIC_KEY) || "null");
      if (old && typeof old.mask === "string") out.mic = { enabled: !!old.enabled, mode: old.mode === "ptt" ? "ptt" : "mute", mask: old.mask };
    }
  } catch (_) {}
  return out;
}

let bindings = load();
const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(bindings));
  } catch (_) {}
};

export const getBindings = () => bindings;

const toBig = (n: any) => {
  try {
    return BigInt(Math.trunc(Number(n) || 0));
  } catch (_) {
    return 0n;
  }
};
function pressedOf(c: any) {
  let m = (toBig(c.ulButtons) | (toBig(c.ulUpperButtons) << 64n)) & ~IGNORED;
  if ((Number(c.sTriggerR) || 0) > TRIGGER_PRESS) m |= bit(B.RT);
  if ((Number(c.sTriggerL) || 0) > TRIGGER_PRESS) m |= bit(B.LT);
  return m;
}

export function describe(mask: string) {
  const m = BigInt(mask || "0");
  if (!m) return "not set";
  const parts: string[] = [];
  // Hold-type buttons first, so it reads "Options/Start + R2".
  const order = [14, 12, 3, 2, ...Array.from({ length: 128 }, (_, i) => i)];
  const seen = new Set<number>();
  for (const b of order) {
    if (seen.has(b)) continue;
    seen.add(b);
    if (m & bit(b)) parts.push(NAMES[b] ?? `button ${b}`);
  }
  return parts.join(" + ");
}

// What a ringing-call notification tells you to press.
export function callHint() {
  const a = bindings.answer.enabled && BigInt(bindings.answer.mask) ? `${describe(bindings.answer.mask)} to answer` : "";
  const d = bindings.decline.enabled && BigInt(bindings.decline.mask) ? `${describe(bindings.decline.mask)} to decline` : "";
  return [a, d].filter(Boolean).join(" · ") || "Answer or decline in Discordio (Quick Access Menu)";
}

// ------------------------------------------------------------ runtime state
let unregister: (() => void) | undefined;
const prev = new Map<number, bigint>();
let pttHeld = false;
let ringing: string | null = null; // channel of a call ringing us
let learn: { action: Action; union: bigint; armed: boolean; done: (mask: bigint) => void } | null = null;
let lastEvent = 0;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => fn());
export const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const learning = () => learn;

export function setRinging(channelId: string | null) {
  ringing = channelId;
}

async function callAction(what: "answer_call" | "decline_call") {
  const cid = ringing;
  if (!cid) return;
  ringing = null; // one press, one action
  try {
    const res: any = await call(what, cid);
    toaster.toast({
      title: "Discordio",
      body: res?.error ? `Couldn't ${what === "answer_call" ? "answer" : "decline"}: ${res.error}` : what === "answer_call" ? "Call answered" : "Call declined",
    });
  } catch (e) {
    toaster.toast({ title: "Discordio", body: String(e) });
  }
}

function edge(now: bigint, before: bigint, mask: string) {
  const want = BigInt(mask || "0");
  if (!want) return 0;
  const isDown = (now & want) === want;
  const wasDown = (before & want) === want;
  return isDown === wasDown ? 0 : isDown ? 1 : -1;
}

function onStates(changes: any[]) {
  lastEvent = Date.now();
  for (const c of changes || []) {
    const idx = c.unControllerIndex ?? 0;
    const now = pressedOf(c);
    const before = prev.get(idx) ?? 0n;
    if (now === before) continue;
    prev.set(idx, now);

    if (learn) {
      // Wait until everything is released (the press that started
      // learning), then collect buttons until all are let go again.
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

    // Calls first: while ringing, their combos win over the mic button.
    if (ringing) {
      if (bindings.answer.enabled && edge(now, before, bindings.answer.mask) === 1) {
        callAction("answer_call");
        continue;
      }
      if (bindings.decline.enabled && edge(now, before, bindings.decline.mask) === 1) {
        callAction("decline_call");
        continue;
      }
    }
    if (bindings.mic.enabled) {
      const e = edge(now, before, bindings.mic.mask);
      if (!e) continue;
      if (bindings.mic.mode === "mute") {
        if (e === 1) call("toggle_mute").catch(() => {});
      } else if ((e === 1) !== pttHeld) {
        pttHeld = e === 1;
        call("set_ptt", pttHeld).catch(() => {});
      }
    }
  }
}

function anyEnabled() {
  return (bindings.mic.enabled && BigInt(bindings.mic.mask) !== 0n) || bindings.answer.enabled || bindings.decline.enabled;
}

function ensureListening() {
  if (unregister) return;
  try {
    const input = (window as any).SteamClient?.Input;
    if (!input?.RegisterForControllerStateChanges) throw new Error("Steam has no controller state API here");
    const r = input.RegisterForControllerStateChanges(onStates);
    unregister = () => r?.unregister?.();
    note("Controller shortcuts", true, "listening to controller buttons");
  } catch (e) {
    note("Controller shortcuts", false, String(e));
  }
}

function stopIfIdle() {
  if (!anyEnabled() && !learn && unregister) {
    try {
      unregister();
    } catch (_) {}
    unregister = undefined;
  }
}

export function update(action: Action, patch: any) {
  const before = bindings.mic;
  bindings = { ...bindings, [action]: { ...(bindings as any)[action], ...patch } };
  save();
  if (action === "mic" && (before.mode !== bindings.mic.mode || before.enabled !== bindings.mic.enabled)) {
    // Discord's push-to-talk mode only while that's what the mic button does.
    call("enable_ptt", bindings.mic.enabled && bindings.mic.mode === "ptt").catch(() => {});
    if (pttHeld) {
      pttHeld = false;
      call("set_ptt", false).catch(() => {});
    }
  }
  call("set_call_hint", callHint()).catch(() => {});
  if (anyEnabled()) ensureListening();
  else stopIfIdle();
  changed();
}

export function reset(action: Action) {
  update(action, JSON.parse(JSON.stringify(DEFAULTS[action])));
}

export function startLearning(action: Action, done: (mask: string | null) => void) {
  ensureListening();
  const startedAt = Date.now();
  learn = {
    action,
    union: 0n,
    armed: false,
    done: (mask) => {
      update(action, { mask: mask.toString(), enabled: true });
      done(mask.toString());
    },
  };
  changed();
  setTimeout(() => {
    if (learn && learn.action === action && lastEvent < startedAt) {
      learn = null;
      stopIfIdle();
      note("Controller shortcuts", false, "no controller state updates arrived while learning");
      done(null);
      changed();
    }
  }, 8000);
}

export function cancelLearning() {
  learn = null;
  stopIfIdle();
  changed();
}

// Called once when the plugin loads.
export function startShortcuts() {
  if (anyEnabled()) ensureListening();
  if (bindings.mic.enabled && bindings.mic.mode === "ptt") call("enable_ptt", true).catch(() => {});
  call("set_call_hint", callHint()).catch(() => {});
}

export function stopShortcuts() {
  learn = null;
  if (unregister) {
    try {
      unregister();
    } catch (_) {}
    unregister = undefined;
  }
}
