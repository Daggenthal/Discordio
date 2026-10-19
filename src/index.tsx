import {
  definePlugin,
  PanelSection,
  PanelSectionRow,
  staticClasses,
  Router,
  sleep,
  Focusable,
  ButtonItem,
  ToggleField,
} from "@decky/ui";
import { FaDiscord } from "react-icons/fa";

import { patchMenu } from "./patches/menuPatch";
import { DiscordTab } from "./components/DiscordTab";
import { useDeckcordState, isLoaded, isLoggedIn } from "./hooks/useDeckcordState";

import { MuteButton } from "./components/buttons/MuteButton";
import { DeafenButton } from "./components/buttons/DeafenButton";
import { DisconnectButton } from "./components/buttons/DisconnectButton";
import { PushToTalkButton, cleanupPtt } from "./components/buttons/PushToTalk";
import { VoiceChannelView } from "./components/VoiceChatViews";
import { ServersPanel, FriendsPanel } from "./components/BrowsePanels";
import { UpdatePanel } from "./components/UpdatePanel";
import { OverlayPanel } from "./components/OverlayPanel";
import { SafeSection } from "./components/SafeSection";
import { useUiSettings, setUiSetting } from "./lib/settings";
import { startMicBridge } from "./lib/mic";
import { AudioDevicesPanel } from "./components/AudioDevicesPanel";
import { useState } from "react";
import { UploadScreenshot } from "./components/UploadScreenshot";
import { OpenDiscordButton } from "./components/buttons/OpenCloseDiscordButton";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel";
import { safe, note } from "./lib/diag";
import { applyBounds } from "./lib/view";
import {
  call,
  routerHook,
  toaster,
  addEventListener,
  removeEventListener,
} from "@decky/api";

declare global {
  interface Window {
    DISCORD_TAB: any;
    DISCORDIO_VIEW: any;
    DISCORDIO_ROUTER: any;
    DECKCORD_ROUTER: any;
  }
}

const Status = ({ state }: { state: any }) => {
  if (!state?.loaded) {
    return (
      <PanelSectionRow>
        <div style={{ textAlign: "center", width: "100%" }}>
          <h3 style={{ margin: "4px 0" }}>Starting Discord...</h3>
          <div style={{ fontSize: "12px", opacity: 0.8 }}>
            {state?.stage ?? "Waiting for the plugin backend"}
          </div>
        </div>
      </PanelSectionRow>
    );
  }
  if (!state?.logged_in) {
    return (
      <PanelSectionRow>
        <div style={{ fontSize: "13px" }}>
          <b>Not logged in.</b> Press <b>Open Discord</b> above and log in (the QR
          code option works well with your phone). If you were already logged in,
          give it a few seconds.
        </div>
      </PanelSectionRow>
    );
  }
  return null;
};

// Starts expanded or collapsed according to the "auto-open" setting each time
// the QAM is opened; the button toggles it for the current view.
const Collapsible = ({ title, children, defaultOpen }: { title: string; children: any; defaultOpen: boolean }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <PanelSection title={title}>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => setOpen(!open)}>
          {open ? `Collapse ${title.toLowerCase()}` : `Show ${title.toLowerCase()}`}
        </ButtonItem>
      </PanelSectionRow>
      {open && children}
    </PanelSection>
  );
};

const SettingsPanel = () => {
  const ui = useUiSettings();
  return (
    <Collapsible title="Settings" defaultOpen={false}>
      <PanelSectionRow>
        <ToggleField
          label="Auto-open Servers"
          description="Show the server list expanded when you open Discordio"
          checked={ui.autoOpenServers}
          onChange={(v) => setUiSetting("autoOpenServers", v)}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleField
          label="Auto-open Friends"
          description="Show the friends list expanded when you open Discordio"
          checked={ui.autoOpenFriends}
          onChange={(v) => setUiSetting("autoOpenFriends", v)}
        />
      </PanelSectionRow>
      <SafeSection name="Audio devices"><AudioDevicesPanel /></SafeSection>
    </Collapsible>
  );
};

const Content = () => {
  const state = useDeckcordState();
  const ui = useUiSettings();
  const ready = state?.loaded && state?.logged_in;

  return (
    <>
      <PanelSection>
        <PanelSectionRow>
          <OpenDiscordButton />
        </PanelSectionRow>
        <Status state={state} />
        {ready && (
          <>
            <PanelSectionRow>
              <Focusable style={{ display: "flex", justifyContent: "center", gap: "4px" }}>
                <MuteButton />
                <DeafenButton />
                <DisconnectButton />
              </Focusable>
            </PanelSectionRow>
            <PanelSectionRow>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                {state?.me?.avatar && (
                  <img
                    src={`https://cdn.discordapp.com/avatars/${state?.me?.id}/${state?.me?.avatar}.webp`}
                    width={32}
                    height={32}
                    style={{ display: "block", borderRadius: "50%" }}
                  />
                )}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {state?.me?.username}
                </span>
              </span>
            </PanelSectionRow>
          </>
        )}
      </PanelSection>
      {ready && (
        <>
          <PanelSection title="Call">
            <SafeSection name="Voice"><VoiceChannelView /></SafeSection>
            <SafeSection name="Push to talk"><PushToTalkButton /></SafeSection>
          </PanelSection>
          <PanelSection title="Overlay">
            <SafeSection name="Overlay"><OverlayPanel /></SafeSection>
          </PanelSection>
          <Collapsible title="Servers" defaultOpen={ui.autoOpenServers}>
            <SafeSection name="Servers"><ServersPanel /></SafeSection>
          </Collapsible>
          <Collapsible title="Friends" defaultOpen={ui.autoOpenFriends}>
            <SafeSection name="Friends"><FriendsPanel /></SafeSection>
          </Collapsible>
          <PanelSection title="Screenshots">
            <SafeSection name="Screenshots"><UploadScreenshot /></SafeSection>
          </PanelSection>
        </>
      )}
      <SafeSection name="Settings"><SettingsPanel /></SafeSection>
      <PanelSection title="Updates">
        <SafeSection name="Updates"><UpdatePanel /></SafeSection>
      </PanelSection>
      <SafeSection name="Diagnostics"><DiagnosticsPanel /></SafeSection>
    </>
  );
};

export default definePlugin(() => {
  // Nothing in here may throw. Every call into Steam's private UI is wrapped,
  // so a change on the Steam beta branch disables one feature instead of
  // keeping the whole plugin out of the Quick Access Menu.

  // Hand the backend a Router reference. The old code relied on window.DFL,
  // which newer Decky builds do not always expose.
  safe("Expose Steam router", () => {
    // The backend creates the Discord view through Steam's router.
    window.DISCORDIO_ROUTER = Router;
    window.DECKCORD_ROUTER = Router;
  });

  // Microphone bridge: Discord's page asks for the mic, this side provides it.
  const stopMic = safe("Microphone bridge listener", () => startMicBridge());

  // DMs and mentions while Discord is closed.
  const notificationListener = (n: { title: string; body: string }) => {
    safe("Show notification", () => toaster.toast({ title: n.title, body: n.body || "" }));
  };
  addEventListener("notification", notificationListener);

  const setPlaying = () => {
    safe("Report current game", () => {
      const app = (Router as any).MainRunningApp;
      call("set_rpc", app !== undefined ? app?.display_name : null);
    });
  };

  const appLifetimeUnregister = safe("Game launch hook", () =>
    SteamClient.GameSessions.RegisterForAppLifetimeNotifications(async () => {
      await sleep(500);
      setPlaying();
    }).unregister
  );

  const unpatchMenu = safe("Main menu entry", () => patchMenu());

  safe("Register /discord route", () =>
    routerHook.addRoute("/discord", () => <DiscordTab />)
  );

  let settingsChangeUnregister: any;
  let lastDisplayIsExternal: boolean | undefined;
  let disposed = false;
  (async () => {
    await isLoaded();
    if (disposed) return;
    note("Backend loaded Discord", true);
    applyBounds();
    settingsChangeUnregister = safe("Display change hook", () =>
      SteamClient.Settings.RegisterForSettingsChanges(async (settings: any) => {
        if (settings?.bDisplayIsExternal !== lastDisplayIsExternal) {
          lastDisplayIsExternal = settings?.bDisplayIsExternal;
          applyBounds();
        }
      })?.unregister
    );
    await isLoggedIn();
    if (disposed) return;
    setPlaying();
  })();

  return {
    name: "Discordio",
    title: <div className={staticClasses.Title}>Discordio</div>,
    content: <Content />,
    icon: <FaDiscord />,
    onDismount() {
      disposed = true;
      removeEventListener("notification", notificationListener);
      for (const fn of [unpatchMenu, appLifetimeUnregister, settingsChangeUnregister, cleanupPtt, stopMic]) {
        try {
          fn?.();
        } catch (_) {}
      }
      try {
        routerHook.removeRoute("/discord");
      } catch (_) {}
    },
    alwaysRender: true,
  };
});
