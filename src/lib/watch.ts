import { call, toaster } from "@decky/api";
import { Router } from "@decky/ui";

// Watching shows the stream in Discord itself.
export const watchStream = async (userId: string, name: string) => {
  const res: any = await call("watch_stream", userId);
  if (res?.error) {
    toaster.toast({ title: "Discordio", body: res.error });
    return;
  }
  toaster.toast({ title: "Discordio", body: `Watching ${name}'s stream` });
  setTimeout(() => Router.Navigate("/discord"), 600);
};
