import { call, toaster } from "@decky/api";
import { Focusable, Navigation, Router } from "@decky/ui";
import { useEffect, useLayoutEffect, useRef } from "react";
import { showDiscord } from "../lib/view";
import { note } from "../lib/diag";
import { setDiscordShowing } from "../lib/loginHandoff";
import { endFullScreen, watchingFullScreen } from "../lib/watch";
import { openDiscordio } from "../lib/reopen";

// Numeric values of @decky/ui's GamepadButton enum (it's a declared enum, so
// it may not exist at runtime).
const BTN = {
  BUMPER_LEFT: 5,
  BUMPER_RIGHT: 6,
  TRIGGER_LEFT: 7,
  TRIGGER_RIGHT: 8,
  SELECT: 13,
  DIR_UP: 9,
  DIR_DOWN: 10,
  DIR_LEFT: 11,
  DIR_RIGHT: 12,
};

const DIRECTIONS: Record<number, string> = {
  [BTN.DIR_UP]: "up",
  [BTN.DIR_DOWN]: "down",
  [BTN.DIR_LEFT]: "left",
  [BTN.DIR_RIGHT]: "right",
};

let navEvents = 0;
const nav = async (action: string) => {
  navEvents++;
  if (navEvents === 1) note("Controller navigation", true, "receiving gamepad input");
  try {
    return await call<[string], any>("discord_nav", action);
  } catch (e) {
    note("Controller navigation", false, String(e));
    return undefined;
  }
};

const close = () => {
  try {
    Navigation.NavigateBack();
  } catch (_) {
    Router.Navigate("/library/home");
  }
};

// Controls while Discord is open:
//   D-pad / stick   move the highlight      A   select
//   B               close popup, else close Discord
//   Y               quick switcher (search servers, channels, DMs)
//   X               toggle mute
//   LB / RB         previous / next server  LT / RT  scroll up / down
//   View / Select   show or hide the on-screen controls legend
export const DiscordTab = () => {
  const shown = useRef(false);
  useEffect(() => {
    setDiscordShowing(true);
    return () => {
      setDiscordShowing(false);
      // Left Discord some other way while watching full screen.
      if (watchingFullScreen()) endFullScreen();
    };
  }, []);

  useLayoutEffect(() => {
    // Show right away, then re-assert for a moment: Steam's route transition
    // can hide the view again on the first frames, which is why the first
    // press of "Open Discord" sometimes did nothing.
    shown.current = showDiscord(true);
    const timers = [50, 200, 500, 1000].map((ms) =>
      setTimeout(() => {
        if (showDiscord(true)) shown.current = true;
      }, ms)
    );

    const check = setTimeout(() => {
      if (shown.current) return;
      call<[], any>("get_state")
        .then((state) => {
          toaster.toast({
            title: "Discordio",
            body: state?.loaded ? "Could not show Discord, try Restart Discord tab in Diagnostics" : `Not ready yet: ${state?.stage ?? "starting"}`,
          });
          Router.Navigate("/library/home");
        })
        .catch(() => Router.Navigate("/library/home"));
    }, 1200);

    return () => {
      timers.forEach(clearTimeout);
      clearTimeout(check);
      showDiscord(false);
    };
  }, []);

  useEffect(() => {
    nav("show-highlight");
    return () => {
      nav("hide-highlight");
    };
  }, []);

  return (
    <Focusable
      style={{ position: "absolute", inset: 0 }}
      noFocusRing
      onGamepadDirection={(e) => {
        const dir = DIRECTIONS[e.detail.button];
        if (dir) nav(dir);
      }}
      onOKButton={() => nav("select")}
      onCancelButton={async () => {
        if (watchingFullScreen()) {
          // Done watching: stop, leave Discord, and land back in the
          // Quick Access Menu over whatever you were doing.
          await endFullScreen();
          close();
          setTimeout(openDiscordio, 400);
          return;
        }
        const res = await nav("back");
        if (!res?.handled) close();
      }}
      onOptionsButton={() => nav("quick-switcher")}
      onSecondaryButton={() => call("toggle_mute")}
      onButtonDown={(e) => {
        switch (e.detail.button) {
          case BTN.BUMPER_LEFT: nav("prev-server"); break;
          case BTN.BUMPER_RIGHT: nav("next-server"); break;
          case BTN.TRIGGER_LEFT: nav("scroll-up"); break;
          case BTN.TRIGGER_RIGHT: nav("scroll-down"); break;
          case BTN.SELECT: nav("toggle-legend"); break;
        }
      }}
      onOKActionDescription="Select"
      onCancelActionDescription="Back"
      onOptionsActionDescription="Search"
      onSecondaryActionDescription="Mute"
    >
      <div style={{ width: "100%", height: "100%" }} />
    </Focusable>
  );
};
