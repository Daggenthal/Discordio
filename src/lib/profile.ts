import { useEffect, useState } from "react";
import { beginRestore, fire, on } from "./events";

// The profile shown inside the Quick Access Menu. While it's open the rest
// of Discordio isn't rendered (hidden parts could still take the
// controller's focus); Back rebuilds it as it was and returns the focus to
// whatever opened the profile (marked with data-dio-key).
export type ProfileTarget = { userId: string | null; key: string | null };
let target: ProfileTarget | null = null;
export const profileTarget = () => target;
export function openProfile(userId: string | null, key: string | null = null) {
  target = { userId, key };
  fire("profile-changed");
}
export function closeProfile() {
  const key = target?.key;
  target = null;
  beginRestore();
  fire("profile-changed");
  if (!key) return;
  // The menu is rebuilt and lists (like friends) load again: keep looking
  // for the button for a few seconds.
  const started = Date.now();
  const tryFocus = () => {
    try {
      const el = document.querySelector<HTMLElement>(`[data-dio-key="${key}"]`);
      const btn = el?.matches("button, .DialogButton, [tabindex]") ? el : el?.querySelector<HTMLElement>("button, .DialogButton, [tabindex]");
      if (btn || el) {
        (btn || el)!.focus();
        (btn || el)!.scrollIntoView({ block: "center" });
        return;
      }
    } catch (_) {}
    if (Date.now() - started < 4000) setTimeout(tryFocus, 150);
  };
  setTimeout(tryFocus, 150);
}
export function useProfileTarget() {
  const [t, setT] = useState(target);
  useEffect(() => on("profile-changed", () => setT(target)), []);
  return t;
}
