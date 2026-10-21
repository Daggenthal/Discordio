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
  await call("end_full_screen").catch(() => {});
  fire("pip-changed");
};

// Or as a small picture in the in-game overlay, while you keep playing.
export const watchInOverlay = async (userId: string, name: string) => {
  // Pressing it again for the same stream closes the picture.
  const cur: any = await call("get_pip").catch(() => null);
  if (cur?.on && cur.user_id === userId) {
    await stopWatching();
    toaster.toast({ title: "Discordio", body: `Stopped watching ${name}'s stream` });
    return;
  }
  const res: any = await call("watch_stream", userId, true, false);
  toaster.toast({
    title: "Discordio",
    body: res?.error ? res.error : `Watching ${name}'s stream in the overlay. Stop it from the Call section.`,
  });
  if (!res?.error) fire("pip-changed");
};

// Someone's webcam in your call, full screen (B goes back) or in the overlay.
export const watchCamera = async (userId: string, name: string) => {
  const res: any = await call("watch_camera", userId, false, true);
  if (res?.error) {
    toaster.toast({ title: "Discordio", body: res.error });
    return;
  }
  fullScreen = name;
  setTimeout(() => Router.Navigate("/discord"), 400);
};

export const watchCameraInOverlay = async (userId: string, name: string) => {
  const cur: any = await call("get_pip").catch(() => null);
  if (cur?.on && cur.user_id === userId && cur.kind === "camera") {
    await stopWatching();
    toaster.toast({ title: "Discordio", body: `Stopped showing ${name}'s camera` });
    return;
  }
  const res: any = await call("watch_camera", userId, true, false);
  toaster.toast({
    title: "Discordio",
    body: res?.error ? res.error : `Showing ${name}'s camera in the overlay. Stop it from the Call section.`,
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
    if (d?.ended)
      toaster.toast({ title: "Discordio", body: d.camera ? `${d.name || "Their"}'s camera turned off` : `${d.name || "They"} stopped streaming` });
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
