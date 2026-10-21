import { ButtonItem, PanelSection, PanelSectionRow } from "@decky/ui";
import { useState } from "react";

const KEY = "DISCORDIO_WELCOME_V1";
const seen = () => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch (_) {
    return false;
  }
};

const small = { fontSize: "12px", lineHeight: 1.4, marginBottom: 6 };

// Shown once, the first time Discordio is opened.
export function WelcomeBanner() {
  const [hidden, setHidden] = useState(seen());
  if (hidden) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(KEY, "1");
    } catch (_) {}
    setHidden(true);
  };
  return (
    <PanelSection title="Welcome to Discordio">
      <PanelSectionRow>
        <div>
          <div style={small}>
            1. Press <b>Open Discord</b> and log in. The QR code works with the Discord app on your phone.
          </div>
          <div style={small}>
            2. If Discord asks you to prove you're human, complete it once in the Discord view.
          </div>
          <div style={small}>
            3. Check your mic and speakers in <b>Audio Settings</b> before your first call.
          </div>
          <div style={{ ...small, opacity: 0.75 }}>
            Discordio runs Discord's web app with Vencord. Client mods are against Discord's terms of service, so use it at
            your own risk.
          </div>
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={dismiss}>
          Got It
        </ButtonItem>
      </PanelSectionRow>
    </PanelSection>
  );
}
