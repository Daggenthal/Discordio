import { call, addEventListener, removeEventListener } from "@decky/api";
import { useEffect, useState } from "react";

export function useDeckcordState() {
  const [state, setState] = useState<any | undefined>();

  useEffect(() => {
    let alive = true;
    call("get_state")
      .then((s) => alive && setState(s))
      .catch(() => {});

    // Keep one reference so removeEventListener actually removes it.
    // (The original passed a fresh arrow function, so listeners leaked
    // every time the QAM panel was opened.)
    const listener = (data: any) => {
      if (alive) setState(data);
    };
    addEventListener("state", listener);

    return () => {
      alive = false;
      removeEventListener("state", listener);
    };
  }, []);

  return state;
}

const waitForFlag = (flag: "loaded" | "logged_in") =>
  new Promise<boolean>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      removeEventListener("state", listener);
      resolve(true);
    };
    const listener = (s: any) => {
      if (s?.[flag]) finish();
    };
    addEventListener("state", listener);
    call("get_state")
      .then((s: any) => {
        if (s?.[flag]) finish();
      })
      .catch(() => {});
  });

export const isLoaded = () => waitForFlag("loaded");
export const isLoggedIn = () => waitForFlag("logged_in");
