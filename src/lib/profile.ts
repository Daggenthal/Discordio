import { Router } from "@decky/ui";

// Which profile the full-screen profile card shows, and which QAM section
// to reopen afterwards.
let target: { userId: string | null; section: string | null } | null = null;
export const profileTarget = () => target;
export function openProfile(userId: string | null, section: string | null = null) {
  target = { userId, section };
  Router.Navigate("/discordio-profile");
}
