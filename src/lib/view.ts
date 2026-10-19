import { Router } from "@decky/ui";
import { note } from "./diag";

// How the Discord browser view is sized.
//   auto:   match Steam's Big Picture window (best guess for TVs / Steam Machine)
//   device: same, but multiplied by devicePixelRatio
//   legacy: original Deckcord behaviour (Steam Deck panel size)
// The gray/blank screen reported on current Steam builds may be a sizing
// problem, so this is switchable from the QAM while testing.
export type BoundsMode = "auto" | "device" | "legacy";

const KEY = "DECKCORD_BOUNDS_MODE";

export const getBoundsMode = (): BoundsMode => {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "auto" || v === "device" || v === "legacy") return v;
  } catch (_) {}
  return "auto";
};

export const setBoundsMode = (m: BoundsMode) => {
  try {
    localStorage.setItem(KEY, m);
  } catch (_) {}
  applyBounds();
};

export const mainWindow = (): any => {
  const ws: any = (Router as any)?.WindowStore;
  return ws?.GamepadUIMainWindowInstance;
};

export const computeBounds = (mode: BoundsMode = getBoundsMode()) => {
  if (mode === "legacy") return { width: 860, height: 495 };
  const bw: Window | undefined = mainWindow()?.BrowserWindow;
  const w = bw?.innerWidth || window.innerWidth || 1280;
  const h = bw?.innerHeight || window.innerHeight || 800;
  const scale = mode === "device" ? bw?.devicePixelRatio || 1 : 1;
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
};

export const applyBounds = () => {
  const tab = (window as any).DISCORDIO_VIEW || (window as any).DISCORD_TAB;
  if (!tab?.m_browserView) return;
  const mode = getBoundsMode();
  const { width, height } = computeBounds(mode);
  tab.WIDTH = width;
  tab.HEIGHT = height;
  try {
    tab.m_browserView.SetBounds(0, 0, width, height);
    note("Size Discord view", true, `${mode} ${width}x${height}`);
  } catch (e) {
    note("Size Discord view", false, String(e));
  }
};

export const showDiscord = (visible: boolean) => {
  const tab = (window as any).DISCORDIO_VIEW || (window as any).DISCORD_TAB;
  if (!tab?.m_browserView) return false;
  if (visible) applyBounds();
  try {
    tab.m_browserView.SetVisible(visible);
    tab.m_browserView.SetFocus(visible);
    return true;
  } catch (e) {
    note("Show Discord view", false, String(e));
    return false;
  }
};
