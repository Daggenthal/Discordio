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
import { PushToTalkButton, CallShortcutsPanel, cleanupPtt, startMicShortcut } from "./components/buttons/PushToTalk";
import { VoiceChannelView } from "./components/VoiceChatViews";
import { ServersPanel, FriendsPanel, FavoritesPanel } from "./components/BrowsePanels";
import { UpdatePanel } from "./components/UpdatePanel";
import { OverlayPanel } from "./components/OverlayPanel";
import { MessagesPanel, MessageSettingsPanel } from "./components/MessagesPanel";
import { SafeSection } from "./components/SafeSection";
import { getUiSettings, setUiSetting, useUiSettings } from "./lib/settings";
import { startMicBridge } from "./lib/mic";
import { AudioDevicesPanel } from "./components/AudioDevicesPanel";
import { WelcomeBanner } from "./components/WelcomeBanner";
import { Badges } from "./components/Badges";
import { PlainButton, SectionHeader } from "./components/SectionHeader";
import { MediaViewer } from "./components/MediaViewer";
import { ProfilePanel } from "./components/ProfileView";
import { openProfile, useProfileTarget } from "./lib/profile";
import { startWatchNotices } from "./lib/watch";
import { STATUSES } from "./components/StatusPanel";
import { MicProcessingPanel } from "./components/MicProcessingPanel";
import { AudioCheckPanel } from "./components/AudioCheckPanel";
import { StreamQualityPanel } from "./components/GoLivePanel";
import { AccountPanel } from "./components/AccountPanel";
import { UpdateBanner } from "./components/UpdatePanel";
import { FriendsCount } from "./components/FriendsCount";
import { StatusPanel } from "./components/StatusPanel";
import { startLoginHandoff } from "./lib/loginHandoff";
import { reopenAfterUpdate } from "./lib/reopen";
import { IncomingCallBanner, startCallNotifications } from "./components/IncomingCall";
import { CaptchaBanner, startCaptchaNotifications } from "./components/CaptchaBanner";
import { useEffect, useRef, useState } from "react";
import { fire, on, remember, restored, takeExpand } from "./lib/events";
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
const Collapsible = ({
  title,
  label,
  children,
  defaultOpen,
  bottomCollapse = true,
  badge,
}: {
  badge?: number;
  title: string;
  label?: string; // what the Show / Collapse button names (defaults to the title)
  children: any;
  defaultOpen: boolean;
  bottomCollapse?: boolean;
}) => {
  const [open, setOpenRaw] = useState(() => restored<boolean>(`section:${title}`) ?? (takeExpand(title) || defaultOpen));
  const setOpen = (v: boolean) => {
    remember(`section:${title}`, v);
    setOpenRaw(v);
  };
  useEffect(() => {
    remember(`section:${title}`, open);
  }, []);
  // e.g. joining a voice channel collapses Servers, so Call / Go Live is in view.
  useEffect(() => on(`collapse:${title}`, () => setOpen(false)), [title]);
  // "Back to Top" tidies up: everything closes.
  useEffect(() => on("collapse-all", () => setOpen(false)), []);
  // e.g. a friend's Message button opens Messages.
  useEffect(() => on(`expand:${title}`, () => setOpen(true)), [title]);
  return (
    <PanelSection>
      <PanelSectionRow>
        <div data-dio-key={`section:${title}`}>
          <SectionHeader title={label ?? title} open={open} badge={badge} onToggle={() => setOpen(!open)} />
        </div>
      </PanelSectionRow>
      {open && children}
      {/* Long sections: close from the bottom too, landing back on the
          section's own button. */}
      {open && bottomCollapse && (
        <PanelSectionRow>
          <div style={{ height: 8 }} />
          <ButtonItem
            layout="below"
            onClick={() => {
              setOpen(false);
              setTimeout(() => {
                try {
                  const el = document.querySelector<HTMLElement>(`[data-dio-key="section:${title}"]`);
                  const btn = el?.querySelector<HTMLElement>("button, .DialogButton, [tabindex]") || el;
                  btn?.focus();
                  btn?.scrollIntoView({ block: "center" });
                } catch (_) {}
              }, 60);
            }}
          >
            Collapse {label ?? title}
          </ButtonItem>
        </PanelSectionRow>
      )}
    </PanelSection>
  );
};

// Your picture with a status dot, your name, and your status underneath.
const ProfileLine = ({ state }: { state: any }) => {
  const st = STATUSES.find((s) => s.value === state?.status?.status);
  const custom = state?.status?.custom;
  const emoji = state?.status?.emoji as { url?: string; text?: string } | null | undefined;
  const ellipsis = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;
  return (
    <span style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
      <span style={{ position: "relative", flex: "none", width: 36, height: 36 }}>
        {state?.me?.avatar ? (
          <img
            src={`https://cdn.discordapp.com/avatars/${state?.me?.id}/${state?.me?.avatar}.webp`}
            width={36}
            height={36}
            style={{ display: "block", borderRadius: "50%" }}
          />
        ) : (
          <span style={{ display: "block", width: 36, height: 36, borderRadius: "50%", background: "#5865f2" }} />
        )}
        {st && (
          <span
            style={{
              position: "absolute", right: -2, bottom: -2, width: 12, height: 12, borderRadius: "50%",
              background: st.color, border: "3px solid #1e2024",
            }}
          />
        )}
      </span>
      <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <span style={{ ...ellipsis, fontWeight: 600 }}>{state?.me?.username}</span>
        {(custom || emoji || st) && (
          <span style={{ fontSize: 12, opacity: 0.75, marginTop: 4, whiteSpace: "normal", overflowWrap: "anywhere", lineHeight: 1.35 }}>
            {emoji?.url && <img src={emoji.url} style={{ width: 16, height: 16, verticalAlign: "-3px", marginRight: 4 }} />}
            {emoji?.text && <span style={{ marginRight: 4 }}>{emoji.text}</span>}
            {custom || (emoji ? "" : st?.label)}
          </span>
        )}
      </span>
    </span>
  );
};

// Your name row can be selected (with a glow) and opens your profile card.
const SelectableProfile = ({ state }: { state: any }) => {
  const [focused, setFocused] = useState(false);
  return (
    <Focusable
      data-dio-key="me"
      onActivate={() => openProfile(null, "me")}
      onOKActionDescription="View Profile"
      {...({ onGamepadFocus: () => setFocused(true), onGamepadBlur: () => setFocused(false) } as any)}
      style={{
        width: "100%", borderRadius: 10, padding: "6px 8px", margin: "0 -8px", boxSizing: "content-box",
        background: focused ? "rgba(255,255,255,0.12)" : "transparent",
        boxShadow: focused ? "0 0 0 2px #fff, 0 0 12px rgba(255,255,255,0.45)" : "none",
        transition: "box-shadow .1s, background .1s",
      }}
    >
      <ProfileLine state={state} />
    </Focusable>
  );
};

const BackToTop = ({ gap = 0 }: { gap?: number }) => (
  <PanelSectionRow>
    {gap > 0 && <div style={{ height: gap }} />}
    <PlainButton
      center
      onClick={() => {
        fire("collapse-all");
        setTimeout(() => fire("jump:top"), 50);
      }}
    >
      ↑ Back to Top
    </PlainButton>
  </PanelSectionRow>
);

const SettingsPanel = () => {
  const ui = useUiSettings();
  const [showUpdates, setShowUpdates] = useState(false);
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
      <PanelSectionRow>
        <ToggleField
          label="Hide Usernames"
          description="For screenshots: hides usernames, and swaps friends' and servers' names for made-up ones"
          checked={ui.hideUsernames}
          onChange={(v) => {
            setUiSetting("hideUsernames", v);
            call("set_hide_names", v).catch(() => {});
          }}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleField
          label="Show Badges"
          description="Your Discord badges under your name"
          checked={ui.showBadges}
          onChange={(v) => setUiSetting("showBadges", v)}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <div style={{ fontWeight: 700, fontSize: "13px", marginTop: "6px" }}>In-game overlay</div>
      </PanelSectionRow>
      <SafeSection name="Overlay"><OverlayPanel /></SafeSection>
      <SafeSection name="Message popups"><MessageSettingsPanel /></SafeSection>
      <PanelSectionRow>
        <div style={{ fontWeight: 700, fontSize: "13px", marginTop: "6px" }}>Stream quality</div>
      </PanelSectionRow>
      <SafeSection name="Stream quality"><StreamQualityPanel /></SafeSection>
      <PanelSectionRow>
        <div style={{ fontWeight: 700, fontSize: "13px", marginTop: "6px" }}>Updates</div>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => setShowUpdates(!showUpdates)}>
          {showUpdates ? "Hide Updates" : "Show Updates"}
        </ButtonItem>
      </PanelSectionRow>
      {showUpdates && <SafeSection name="Updates"><UpdatePanel /></SafeSection>}
      <SafeSection name="Account"><AccountPanel /></SafeSection>
      {/* Spaced away from Logout so it isn't pressed by accident. */}
      <BackToTop gap={18} />
    </Collapsible>
  );
};

const Content = () => {
  const state = useDeckcordState();
  const ui = useUiSettings();
  const ready = state?.loaded && state?.logged_in;
  const topRef = useRef<HTMLDivElement>(null);
  // Unread count on the Messages button.
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    if (!ready) return;
    const load = () => call<[], number>("get_unread_total").then((n) => setUnread(Number(n) || 0)).catch(() => {});
    load();
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [ready]);
  // "Back to Top" buttons: move the view and the controller's focus to the
  // first thing in Discordio, so the next press continues from there.
  useEffect(
    () =>
      on("jump:top", () => {
        try {
          const a = topRef.current;
          a?.scrollIntoView({ behavior: "smooth", block: "start" });
          a?.parentElement?.querySelector<HTMLElement>("button, .DialogButton, input, [tabindex]")?.focus();
        } catch (_) {}
      }),
    [],
  );

  // A profile opens inside the menu, covering the rest until Back (which
  // keeps every section as it was).
  const target = useProfileTarget();
  const profile = target?.where === "me" ? target : null;
  return (
    <>
      {profile && <SafeSection name="Profile"><ProfilePanel userId={profile.userId} /></SafeSection>}
      {!profile && <div>
      <div ref={topRef} />
      <SafeSection name="Update banner"><UpdateBanner /></SafeSection>
      <SafeSection name="Welcome"><WelcomeBanner /></SafeSection>
      {ready && <SafeSection name="Incoming call"><IncomingCallBanner /></SafeSection>}
      {ready && <SafeSection name="Human check"><CaptchaBanner /></SafeSection>}
      <PanelSection>
        {/* Logged in, Open Discord lives in Settings; mute / deafen in
            Audio Settings and the Call section. */}
        {!ready && (
          <PanelSectionRow>
            <OpenDiscordButton />
          </PanelSectionRow>
        )}
        <Status state={state} />
        {ready && (
          <>
            <PanelSectionRow>
              <SafeSection name="Friends count"><FriendsCount /></SafeSection>
            </PanelSectionRow>
            <PanelSectionRow>
              <SelectableProfile state={state} />
            </PanelSectionRow>
            {ui.showBadges && <SafeSection name="Badges"><Badges userId={state?.me?.id} /></SafeSection>}
            <SafeSection name="Status"><StatusPanel status={state?.status} /></SafeSection>
          </>
        )}
      </PanelSection>
      {ready && (
        <>
          {state?.vc && Object.keys(state.vc).length > 0 && (
            <PanelSection title="Call">
              <PanelSectionRow>
                <Focusable style={{ display: "flex", justifyContent: "center", gap: "4px", margin: "2px 0 6px" }}>
                  <MuteButton />
                  <DeafenButton />
                  <DisconnectButton />
                </Focusable>
              </PanelSectionRow>
              <SafeSection name="Voice"><VoiceChannelView /></SafeSection>
            </PanelSection>
          )}
          <SafeSection name="Favorites"><FavoritesPanel /></SafeSection>
          <Collapsible title="Audio Settings" defaultOpen={false}>
            <PanelSectionRow>
              <Focusable style={{ display: "flex", justifyContent: "center", gap: "4px", margin: "2px 0 6px" }}>
                <MuteButton />
                <DeafenButton />
              </Focusable>
            </PanelSectionRow>
            <SafeSection name="Audio devices"><AudioDevicesPanel /></SafeSection>
            <SafeSection name="Voice processing"><MicProcessingPanel /></SafeSection>
            <SafeSection name="Audio check"><AudioCheckPanel /></SafeSection>
            <SafeSection name="Mic button"><PushToTalkButton /></SafeSection>
            <SafeSection name="Call shortcuts"><CallShortcutsPanel /></SafeSection>
          </Collapsible>
          <Collapsible title="Messages" label="Recent Messages" badge={unread} defaultOpen={false} bottomCollapse={false}>
            <SafeSection name="Messages"><MessagesPanel /></SafeSection>
          </Collapsible>
          <Collapsible title="Servers" defaultOpen={ui.autoOpenServers}>
            <SafeSection name="Servers"><ServersPanel /></SafeSection>
          </Collapsible>
          <Collapsible title="Friends" defaultOpen={ui.autoOpenFriends}>
            <SafeSection name="Friends"><FriendsPanel /></SafeSection>
          </Collapsible>
          <Collapsible title="Screenshots" defaultOpen={false}>
            <SafeSection name="Screenshots"><UploadScreenshot /></SafeSection>
          </Collapsible>
        </>
      )}
      <SafeSection name="Settings"><SettingsPanel /></SafeSection>
      <SafeSection name="Diagnostics"><DiagnosticsPanel /></SafeSection>
      <PanelSection>
        <BackToTop />
      </PanelSection>
      </div>}
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
  safe("Controller mic button", () => startMicShortcut());
  const stopCallNotifications = safe("Incoming call notifications", () => startCallNotifications());
  const stopCaptchaNotifications = safe("Human check notifications", () => startCaptchaNotifications());
  const stopLoginHandoff = safe("Login hand-off", () => startLoginHandoff());
  const stopWatchNotices = safe("Stream notices", () => startWatchNotices());
  // Hide Usernames lives on this Steam install; tell the backend at load.
  safe("Sync Hide Usernames", () => {
    call("set_hide_names", getUiSettings().hideUsernames).catch(() => {});
  });
  safe("Reopen after update", () =>
    call<[], any>("get_update_info").then((i) => reopenAfterUpdate(i?.current_build ? `build ${i.current_build}` : "")).catch(() => reopenAfterUpdate(""))
  );

  // DMs and mentions: the overlay shows them as popups; when it can't, a Steam toast.
  const notificationListener = (m: any) => {
    if (!m?.toast) return;
    safe("Show notification", () =>
      toaster.toast({
        title: m.is_dm ? m.author?.name : `${m.author?.name} · ${m.channel_label}`,
        body: m.text || "",
        logo: m.author?.avatar ? <img src={m.author.avatar} style={{ borderRadius: "50%", width: "100%" }} /> : undefined,
      })
    );
  };
  addEventListener("message", notificationListener);

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
  safe("Register the media viewer route", () =>
    routerHook.addRoute("/discordio-view", () => <MediaViewer />)
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
      removeEventListener("message", notificationListener);
      for (const fn of [unpatchMenu, appLifetimeUnregister, settingsChangeUnregister, cleanupPtt, stopMic, stopCallNotifications, stopCaptchaNotifications, stopLoginHandoff, stopWatchNotices]) {
        try {
          fn?.();
        } catch (_) {}
      }
      try {
        routerHook.removeRoute("/discord");
        try {
          routerHook.removeRoute("/discordio-view");
        } catch (_) {}
      } catch (_) {}
    },
    alwaysRender: true,
  };
});
