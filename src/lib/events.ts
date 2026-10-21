// Tiny in-QAM event bus, e.g. "collapse the Servers list after joining".
type Fn = (data?: any) => void;
const listeners = new Map<string, Set<Fn>>();

export const on = (name: string, fn: Fn) => {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name)!.add(fn);
  return () => {
    listeners.get(name)?.delete(fn);
  };
};

export const fire = (name: string, data?: any) => listeners.get(name)?.forEach((fn) => fn(data));

// Sections to open the next time they mount (the QAM was closed, e.g.
// while viewing an image full screen).
const expandOnMount = new Set<string>();
export const expandLater = (title: string) => expandOnMount.add(title);
export const takeExpand = (title: string) => expandOnMount.delete(title);

// Coming back from a profile (which replaces the menu): sections and
// conversations reopen as they were.
const remembered = new Map<string, any>();
let restoringUntil = 0;
export const remember = (key: string, value: any) => remembered.set(key, value);
export const beginRestore = () => {
  restoringUntil = Date.now() + 1500;
};
export const restored = <T,>(key: string): T | undefined => (Date.now() < restoringUntil ? remembered.get(key) : undefined);
