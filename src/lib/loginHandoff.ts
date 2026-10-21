import { addEventListener, call, removeEventListener, toaster } from "@decky/api";
import { Navigation, Router } from "@decky/ui";
import { note } from "./diag";

// After you log in (QR code or password) Discord stays on screen. As soon as
// the login goes through, go back to the library and open Discordio in the
// Quick Access Menu, where everything is used from.
// Whether the Discord page is on screen. The hand-off is only for someone
// looking at Discord's login page: after an update (or Discord reloading)
// the account briefly reads as logged out, and that used to pull you out of
// your game to the library.
let discordShowing = false;
export const setDiscordShowing = (v: boolean) => {
  discordShowing = v;
};

export function startLoginHandoff() {
  let loggedIn: boolean | null = null;
  call<[], any>("get_state")
    .then((s) => {
      if (loggedIn === null && s?.loaded) loggedIn = !!s.logged_in;
    })
    .catch(() => {});

  const onState = (s: any) => {
    if (!s?.loaded) return;
    const now = !!s.logged_in;
    const was = loggedIn;
    loggedIn = now;
    if (was !== false || !now) return; // only on a fresh login
    if (!discordShowing) return; // not logging in on screen: stay where you are
    const name = s?.me?.username;
    try {
      const game = (Router as any).MainRunningApp;
      if (game) {
        // A game is running: straight back into it.
        Navigation.NavigateBack();
      } else {
        Router.Navigate("/library/home");
        setTimeout(() => {
          try {
            Navigation.OpenQuickAccessMenu(999 as any); // the Decky tab
          } catch (_) {}
        }, 400);
      }
      note("Login hand-off", true, game ? `back to ${game.display_name}` : "back to the library");
    } catch (e) {
      note("Login hand-off", false, String(e));
    }
    // Say so where message popups appear (the overlay), or as a Steam toast.
    const text = `Logged in${name ? ` as ${name}` : ""}. Discordio will keep running in the background.`;
    call<[string, string], boolean>("show_notice", "Login Successful", text)
      .then((shown) => {
        if (!shown) toaster.toast({ title: "Login Successful", body: text, duration: 8000 } as any);
      })
      .catch(() => toaster.toast({ title: "Login Successful", body: text }));
  };
  addEventListener("state", onState);
  return () => removeEventListener("state", onState);
}
