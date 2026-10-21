import { addEventListener, call, removeEventListener, toaster } from "@decky/api";
import { Router } from "@decky/ui";
import { fire } from "./events";

// Watching full screen: Discord opens showing only the stream; B stops
// watching and brings you back (see DiscordTab).
let fullScreen: string | null = null;
export const watchingFullScreen = () => fullScreen;

export const watchStream = async (userId: string, name: string) => {
  const res: any = await call("watch_stream", userId, false, true);
  if (res?.error) {
    toaster.toast({ title: "Discordio", body: res.error });
    return;
  }
  fullScreen = name;
  setTimeout(() => Router.Navigate("/discord"), 400);
};

export const endFullScreen = async () => {
  fullScreen = null;
  await call("stop_watching").catch(() => {});
  fire("pip-changed");
};

// Or as a small picture in the in-game overlay, while you keep playing.
export const watchInOverlay = async (userId: string, name: string) => {
  const res: any = await call("watch_stream", userId, true, false);
  toaster.toast({
    title: "Discordio",
    body: res?.error ? res.error : `Watching ${name}'s stream in the overlay. Stop it from the Call section.`,
  });
  if (!res?.error) fire("pip-changed");
};

export const stopWatching = async () => {
  fullScreen = null;
  await call("stop_watching");
  fire("pip-changed");
};

// Tell you when the person stops streaming. Registered once at load.
export function startWatchNotices() {
  const onPip = (d: any) => {
    if (d?.ended) toaster.toast({ title: "Discordio", body: `${d.name || "They"} stopped streaming` });
    else if (d?.error) toaster.toast({ title: "Discordio", body: `Couldn't show the stream: ${d.error}` });
    fire("pip-changed");
  };
  addEventListener("pip", onPip);
  return () => {
    try {
      removeEventListener("pip", onPip);
    } catch (_) {}
  };
}
