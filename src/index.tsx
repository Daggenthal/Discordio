import {
  definePlugin,
  PanelSection,
  PanelSectionRow,
  staticClasses,
  Router,
  sleep,
  Focusable,
} from "@decky/ui";
import { FaDiscord } from "react-icons/fa";

import { patchMenu } from "./patches/menuPatch";
import { DiscordTab } from "./components/DiscordTab";
import { useDeckcordState, isLoaded, isLoggedIn } from "./hooks/useDeckcordState";

import { MuteButton } from "./components/buttons/MuteButton";
import { DeafenButton } from "./components/buttons/DeafenButton";
import { DisconnectButton } from "./components/buttons/DisconnectButton";
import { PushToTalkButton, cleanupPtt } from "./components/buttons/PushToTalk";
import { VoiceChatChannel, VoiceChatMembers } from "./components/VoiceChatViews";
import { UploadScreenshot } from "./components/UploadScreenshot";
import { OpenDiscordButton } from "./components/buttons/OpenCloseDiscordButton";
import { GoLivePanel } from "./components/GoLivePanel";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel";
import { safe, safeAsync, note } from "./lib/diag";
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
    DECKCORD_ROUTER: any;
    DECKCORD: {
      dispatchNotification: any;
      MIC_PEER_CONNECTION: any;
    };
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

const Content = () => {
  const state = useDeckcordState();
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
              <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
                {state?.me?.avatar && (
                  <img
                    src={`https://cdn.discordapp.com/avatars/${state?.me?.id}/${state?.me?.avatar}.webp`}
                    width={32}
                    height={32}
                    style={{ display: "block", borderRadius: "50%" }}
                  />
                )}
                {state?.me?.username}
              </span>
            </PanelSectionRow>
            <PanelSectionRow>
              <VoiceChatChannel />
              <VoiceChatMembers />
            </PanelSectionRow>
          </>
        )}
      </PanelSection>
      {ready && (
        <>
          <PanelSection title="Voice">
            <PushToTalkButton />
          </PanelSection>
          <PanelSection title="Stream">
            <GoLivePanel />
          </PanelSection>
          <PanelSection title="Screenshots">
            <PanelSectionRow>
              <UploadScreenshot />
            </PanelSectionRow>
          </PanelSection>
        </>
      )}
      <DiagnosticsPanel backend={state} />
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
    window.DECKCORD_ROUTER = Router;
  });

  window.DECKCORD = {
    dispatchNotification: (payload: { title: string; body: string }) => {
      safe("Show notification", () => toaster.toast(payload));
    },
    MIC_PEER_CONNECTION: undefined,
  };

  let peerConnection: RTCPeerConnection | undefined;
  const webrtcEventListener = async (data: any) => {
    if (!data?.webrtc) return;
    data = data.webrtc;
    if (data.offer) {
      await safeAsync("Microphone bridge", async () => {
        if (peerConnection) peerConnection.close();
        const pc = new RTCPeerConnection();
        peerConnection = pc;
        window.DECKCORD.MIC_PEER_CONNECTION = pc;
        const localStream = await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
        localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await call("mic_webrtc_answer", answer);
      });
    } else if (data.ice && peerConnection) {
      try {
        let waited = 0;
        while (peerConnection.remoteDescription == null && waited < 5000) {
          await sleep(10);
          waited += 10;
        }
        await peerConnection.addIceCandidate(data.ice);
      } catch (e) {
        console.error("Deckcord: Error adding received ice candidate", e);
      }
    }
  };
  addEventListener("state", webrtcEventListener);

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
      removeEventListener("state", webrtcEventListener);
      for (const fn of [unpatchMenu, appLifetimeUnregister, settingsChangeUnregister, cleanupPtt]) {
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
