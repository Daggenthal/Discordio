import { useEffect, useState } from "react";

// Favorite voice channels, pinned at the top of Discordio for one-press
// joining. Kept on this device.
export type Favorite = { id: string; name: string; guild: string };
const KEY = "DISCORDIO_FAVORITES";
const listeners = new Set<() => void>();

export const getFavorites = (): Favorite[] => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
};

const save = (list: Favorite[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 12)));
  } catch (_) {}
  listeners.forEach((fn) => fn());
};

export const isFavorite = (id: string) => getFavorites().some((f) => f.id === id);

export const toggleFavorite = (f: Favorite) => {
  const list = getFavorites();
  save(list.some((x) => x.id === f.id) ? list.filter((x) => x.id !== f.id) : [...list, f]);
  return !list.some((x) => x.id === f.id);
};

export function useFavorites() {
  const [list, setList] = useState(getFavorites());
  useEffect(() => {
    const fn = () => setList(getFavorites());
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return list;
}
