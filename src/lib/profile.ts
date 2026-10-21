import { useEffect, useState } from "react";
import { fire, on } from "./events";

// The profile shown inside the Quick Access Menu (it covers the rest of
// Discordio until you go back, which keeps everything else as it was).
export type ProfileTarget = { userId: string | null };
let target: ProfileTarget | null = null;
export const profileTarget = () => target;
let returnFocus: HTMLElement | null = null;
export function openProfile(userId: string | null) {
  if (!target) returnFocus = document.activeElement as HTMLElement | null;
  target = { userId };
  fire("profile-changed");
}
export function closeProfile() {
  target = null;
  fire("profile-changed");
  // Back to the button that opened it.
  const el = returnFocus;
  returnFocus = null;
  setTimeout(() => {
    try {
      el?.focus();
      el?.scrollIntoView({ block: "center" });
    } catch (_) {}
  }, 80);
}
export function useProfileTarget() {
  const [t, setT] = useState(target);
  useEffect(() => on("profile-changed", () => setT(target)), []);
  return t;
}
