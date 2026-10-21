import { useEffect, useState } from "react";

// Small per-device UI settings kept in Steam's localStorage.
export type UiSettings = {
  autoOpenServers: boolean;
  autoOpenFriends: boolean;
  showBadges: boolean;
};

const DEFAULTS: UiSettings = {
  autoOpenServers: true,
  // Off by default: long friend lists flood the QAM.
  autoOpenFriends: false,
  showBadges: true,
};

const KEY = "DISCORDIO_UI_SETTINGS";
const listeners = new Set<() => void>();

export const getUiSettings = (): UiSettings => {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch (_) {
    return { ...DEFAULTS };
  }
};

export const setUiSetting = <K extends keyof UiSettings>(key: K, value: UiSettings[K]) => {
  const next = { ...getUiSettings(), [key]: value };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch (_) {}
  listeners.forEach((l) => l());
};

export function useUiSettings(): UiSettings {
  const [s, setS] = useState(getUiSettings());
  useEffect(() => {
    const l = () => setS(getUiSettings());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return s;
}
