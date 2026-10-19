import { call, toaster } from "@decky/api";
import { Router } from "@decky/ui";
import { useLayoutEffect } from "react";
import { showDiscord } from "../lib/view";

export const DiscordTab = () => {
  useLayoutEffect(() => {
    let cancelled = false;
    call<[], any>("get_state")
      .then((state) => {
        if (cancelled) return;
        if (state?.loaded && showDiscord(true)) return;
        toaster.toast({
          title: "Discordio",
          body: state?.stage
            ? `Not ready yet: ${state.stage}`
            : "Discordio has not loaded yet!",
        });
        Router.Navigate("/library/home");
      })
      .catch(() => Router.Navigate("/library/home"));

    return () => {
      cancelled = true;
      showDiscord(false);
    };
  }, []);
  return <div></div>;
};
