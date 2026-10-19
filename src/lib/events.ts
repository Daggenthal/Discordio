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
