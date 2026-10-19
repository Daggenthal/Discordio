import { addEventListener, call, removeEventListener, toaster } from "@decky/api";
import { ButtonItem, PanelSection, PanelSectionRow, Router } from "@decky/ui";
import { useEffect, useState } from "react";

// Discord's "are you human?" check happens inside the hidden Discord view;
// this tells you, and opens Discord so you can finish it.
export function startCaptchaNotifications() {
  const onCaptcha = (d: any) => {
    if (!d?.active) return;
    toaster.toast({
      title: "Discord wants a quick human check",
      body: "Open Discord to finish it (select this)",
      duration: 10000,
      onClick: () => Router.Navigate("/discord"),
    } as any);
  };
  addEventListener("captcha", onCaptcha);
  return () => removeEventListener("captcha", onCaptcha);
}

export function CaptchaBanner() {
  const [active, setActive] = useState(false);
  useEffect(() => {
    call<[], { active: boolean }>("get_captcha").then((r) => setActive(!!r?.active)).catch(() => {});
    const on = (d: any) => setActive(!!d?.active);
    addEventListener("captcha", on);
    return () => removeEventListener("captcha", on);
  }, []);
  if (!active) return null;
  return (
    <PanelSection title="Human check">
      <PanelSectionRow>
        <div style={{ fontSize: 12, color: "#f0b232" }}>
          Discord is asking you to prove you're human. Whatever you just did (like Go Live) waits until it's done.
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => Router.Navigate("/discord")}>
          Open Discord to finish
        </ButtonItem>
      </PanelSectionRow>
    </PanelSection>
  );
}
