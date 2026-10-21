import { call, toaster } from "@decky/api";
import { Router } from "@decky/ui";
import { fire } from "./events";

// Watching shows the stream in Discord itself.
export const watchStream = async (userId: string, name: string) => {
  const res: any = await call("watch_stream", userId, false);
  if (res?.error) {
    toaster.toast({ title: "Discordio", body: res.error });
    return;
  }
  toaster.toast({ title: "Discordio", body: `Watching ${name}'s stream` });
  setTimeout(() => Router.Navigate("/discord"), 600);
};

// Or as a small picture in the in-game overlay, while you keep playing.
export const watchInOverlay = async (userId: string, name: string) => {
  const res: any = await call("watch_stream", userId, true);
  toaster.toast({
    title: "Discordio",
    body: res?.error ? res.error : `Watching ${name}'s stream in the overlay. Stop it from the Call section.`,
  });
  if (!res?.error) fire("pip-changed");
};

export const stopWatching = async () => {
  await call("stop_watching");
  fire("pip-changed");
};
