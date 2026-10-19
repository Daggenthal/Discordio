// Diagnostics for the frontend.
//
// Every hook into Steam's private UI goes through `safe()`. If Valve changes
// something on a beta branch, that one feature fails and gets recorded here,
// instead of throwing out of definePlugin and hiding the whole plugin from
// the Quick Access Menu (the "installs but never shows up" bug).

export type DiagEntry = { step: string; ok: boolean; detail?: string };

const entries: DiagEntry[] = [];
const listeners = new Set<() => void>();

const record = (entry: DiagEntry) => {
  const i = entries.findIndex((e) => e.step === entry.step);
  if (i >= 0) entries[i] = entry;
  else entries.push(entry);
  const tag = entry.ok ? "ok" : "FAILED";
  console.log(`[Deckcord] ${entry.step}: ${tag}${entry.detail ? " (" + entry.detail + ")" : ""}`);
  listeners.forEach((l) => {
    try {
      l();
    } catch (_) {}
  });
};

const describe = (e: unknown) =>
  e instanceof Error ? `${e.name}: ${e.message}` : String(e);

export function safe<T>(step: string, fn: () => T, fallback?: T): T | undefined {
  try {
    const result = fn();
    record({ step, ok: true });
    return result;
  } catch (e) {
    record({ step, ok: false, detail: describe(e) });
    return fallback;
  }
}

export async function safeAsync<T>(step: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const result = await fn();
    record({ step, ok: true });
    return result;
  } catch (e) {
    record({ step, ok: false, detail: describe(e) });
    return undefined;
  }
}

export const note = (step: string, ok: boolean, detail?: string) =>
  record({ step, ok, detail });

export const getDiag = () => entries.slice();

export const subscribeDiag = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

// Slider events, to diagnose sliders that don't move: each left / right
// press, what the slider reported, what was saved, and what came back.
export type SliderEvent = { t: number; slider: string; what: string };
const sliderLog: SliderEvent[] = [];
export const logSlider = (slider: string, what: string) => {
  sliderLog.push({ t: Date.now(), slider, what });
  if (sliderLog.length > 40) sliderLog.shift();
  listeners.forEach((l) => {
    try {
      l();
    } catch (_) {}
  });
};
export const getSliderLog = () => sliderLog.slice();
