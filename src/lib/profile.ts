import { useEffect, useState } from "react";
import { beginRestore, fire, on } from "./events";

// The profile shown inside the Quick Access Menu. While it's open the rest
// of Discordio isn't rendered (hidden parts could still take the
// controller's focus); Back rebuilds it as it was and returns the focus to
// whatever opened the profile (marked with data-dio-key).
// where: "me" covers the whole menu; "friends" / "call" show the profile in
// place of that list only, so going back leaves you in that list.
export type ProfileTarget = { userId: string | null; key: string | null; where: "me" | "friends" | "call" };
let target: ProfileTarget | null = null;
export const profileTarget = () => target;
export function openProfile(userId: string | null, key: string | null = null, where: "me" | "friends" | "call" = "me") {
  target = { userId, key, where };
  fire("profile-changed");
}
export function closeProfile() {
  const key = target?.key;
  const where = target?.where;
  target = null;
  if (where === "me") beginRestore();
  fire("profile-changed");
  if (!key) return;
  // The menu is rebuilt and lists (like friends) load again, and Steam may
  // put the cursor back at the top after we've moved it: keep putting it on
  // the button (or, failing that, its section) for a moment.
  const started = Date.now();
  const find = (): HTMLElement | null => {
    const el = document.querySelector<HTMLElement>(`[data-dio-key="${key}"]`) ||
      (key.startsWith("friend") ? document.querySelector<HTMLElement>('[data-dio-key="section:Friends"]') : null);
    if (!el) return null;
    return el.matches("button, .DialogButton, [tabindex]") ? el : el.querySelector<HTMLElement>("button, .DialogButton, [tabindex]") || el;
  };
  let placedAt = 0;
  const tick = () => {
    try {
      const el = find();
      if (el && !el.contains(document.activeElement)) {
        el.focus();
        el.scrollIntoView({ block: "center" });
        if (!placedAt) placedAt = Date.now();
      } else if (el && !placedAt) placedAt = Date.now();
    } catch (_) {}
    const now = Date.now();
    if ((placedAt && now - placedAt < 1500) || (!placedAt && now - started < 4000)) setTimeout(tick, 120);
  };
  setTimeout(tick, 100);
}
export function useProfileTarget() {
  const [t, setT] = useState(target);
  useEffect(() => on("profile-changed", () => setT(target)), []);
  return t;
}
