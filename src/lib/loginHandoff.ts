import { addEventListener, call, removeEventListener, toaster } from "@decky/api";
import { Navigation, Router } from "@decky/ui";
import { note } from "./diag";

// After you log in (QR code or password) Discord stays on screen. As soon as
// the login goes through, go back to the library and open Discordio in the
// Quick Access Menu, where everything is used from.
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
    const name = s?.me?.username;
    try {
      Router.Navigate("/library/home");
      setTimeout(() => {
        try {
          Navigation.OpenQuickAccessMenu(999 as any); // the Decky tab
        } catch (_) {}
      }, 400);
      toaster.toast({ title: "Discordio", body: name ? `Logged in as ${name}` : "Logged in to Discord" });
      note("Login hand-off", true, "back to the library");
    } catch (e) {
      note("Login hand-off", false, String(e));
    }
  };
  addEventListener("state", onState);
  return () => removeEventListener("state", onState);
}
