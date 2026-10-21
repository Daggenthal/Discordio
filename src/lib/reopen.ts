import { toaster } from "@decky/api";
import { Navigation } from "@decky/ui";
import { note } from "./diag";

// Updating reloads Discordio. A note left before the update lets the new
// build reopen itself afterwards, so you land back where you were.
const KEY = "DISCORDIO_REOPEN_AFTER_UPDATE";

export function markUpdating(fromBuild: number | undefined, toLabel: string | undefined) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), from: fromBuild ?? null, to: toLabel ?? null }));
  } catch (_) {}
}

export function clearUpdating() {
  try {
    localStorage.removeItem(KEY);
  } catch (_) {}
}

export function openDiscordio() {
  try {
    Navigation.OpenQuickAccessMenu(999 as any); // the Decky tab
  } catch (_) {}
  // Straight into Discordio rather than Decky's plugin list, when Decky
  // exposes that (it's internal, so this may not exist on every version).
  setTimeout(() => {
    try {
      const loader = (window as any).DeckyPluginLoader;
      loader?.deckyState?.setActivePlugin?.("Discordio");
    } catch (_) {}
  }, 300);
}

// Called when the plugin loads: reopen if we were just updated.
export function reopenAfterUpdate(currentBuild: string) {
  let pending: any = null;
  try {
    pending = JSON.parse(localStorage.getItem(KEY) || "null");
  } catch (_) {}
  if (!pending) return;
  clearUpdating();
  if (Date.now() - (pending.at || 0) > 5 * 60 * 1000) return; // stale
  // Close the Quick Access Menu and open it again, so the new build shows
  // up fresh, without leaving the game you're in.
  setTimeout(() => {
    try {
      Navigation.CloseSideMenus();
    } catch (_) {}
  }, 1000);
  setTimeout(() => {
    openDiscordio();
    toaster.toast({ title: "Discordio", body: `Updated${currentBuild ? ` to ${currentBuild}` : ""}` });
    note("Reopen after update", true, currentBuild);
  }, 1800);
}
