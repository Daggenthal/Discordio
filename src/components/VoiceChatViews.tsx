import { call } from "@decky/api";
import { ButtonItem, PanelSectionRow, ToggleField, Focusable } from "@decky/ui";
import { toaster } from "@decky/api";
import { ChoiceSlider } from "./ChoiceSlider";
import { watchInOverlay, watchStream } from "../lib/watch";
import { PipControls } from "./PipControls";
import { openProfile } from "../lib/profile";
import { remember, restored } from "../lib/events";
import { GoLivePanel } from "./GoLivePanel";
import { useEffect, useRef, useState } from "react";
import { FaMicrophoneSlash, FaVolumeMute, FaVideo, FaPhoneSlash } from "react-icons/fa";
import { useDeckcordState } from "../hooks/useDeckcordState";

export type Member = {
  id: string;
  name: string;
  avatar: string | null;
  muted: boolean;
  deafened: boolean;
  live: boolean;
  video?: boolean;
  server_muted?: boolean;
  server_deafened?: boolean;
  local_muted?: boolean;
  volume?: number;
};

export type VoiceInfo = {
  channel_id: string;
  can?: { mute: boolean; deafen: boolean; move: boolean };
  me?: string | null;
  guild_id?: string | null;
  channel_name: string;
  guild_name: string;
  members: Member[];
} | null;

const isVoice = (v: any): v is NonNullable<VoiceInfo> => !!v && typeof v === "object" && !v.error && !!v.channel_id;

// Polls the Discord page for the current call while the panel is visible.
// The data comes straight from Discord's voice state store, so mute, deafen
// and streaming flags are accurate for everyone in the channel.
export function useVoice(intervalMs = 2000) {
  const state = useDeckcordState();
  const [voice, setVoice] = useState<VoiceInfo>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      call<[string], any>("discord_query", "voice")
        .then((v) => alive && setVoice(isVoice(v) ? { ...v, members: Array.isArray(v.members) ? v.members : [] } : null))
        .catch(() => {});
    load();
    const t = setInterval(load, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // Reload immediately when the backend reports a voice change.
  }, [state?.vc?.channel_name, (state?.vc?.users || []).length]);

  return voice;
}

export const Avatar = ({ src, size = 24 }: { src: string | null; size?: number }) =>
  src ? (
    <img src={src} width={size} height={size} style={{ borderRadius: "50%", flexShrink: 0, display: "block" }} />
  ) : (
    <div style={{ width: size, height: size, borderRadius: "50%", background: "#5865f2", flexShrink: 0 }} />
  );

export const MemberRow = ({ m }: { m: Member }) => (
  <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "3px 0", minWidth: 0 }}>
    <Avatar src={m.avatar} />
    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
      {m.name}
    </span>
    {m.live && (
      <span style={{ background: "#ed4245", color: "white", fontSize: "10px", fontWeight: 700, padding: "1px 5px", borderRadius: "4px" }}>
        LIVE
      </span>
    )}
    {m.video && <FaVideo size={12} />}
    {m.deafened ? <FaVolumeMute size={13} color="#ed4245" /> : m.muted ? <FaMicrophoneSlash size={13} color="#ed4245" /> : null}
  </div>
);

// Everything about the call you're in: who's there, disconnect, and Go Live.
// Works the same for server voice channels and direct calls with friends.
let lastSeenCall: string | null = null;

export function VoiceChannelView() {
  const voice = useVoice();
  const anchor = useRef<HTMLDivElement>(null);
  const [openId, setOpenIdRaw] = useState<string | null>(() => restored<string | null>("member") ?? null);
  const setOpenId = (v: string | null) => {
    remember("member", v);
    setOpenIdRaw(v);
  };


  // When you join a call (or switch to another), bring the Call section into
  // view and put the controller focus on Go Live, so streaming is one press
  // away instead of buried below the server list.
  useEffect(() => {
    // The Call section only exists while you're in a call, so this view
    // mounts when you join; remember the last call across mounts so
    // reopening the menu in the same call doesn't jump again.
    const id = voice?.channel_id ?? null;
    if (!id || lastSeenCall === id) return;
    lastSeenCall = id;
    const t = setTimeout(() => {
      const root = anchor.current;
      if (!root) return;
      try {
        root.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (_) {}
      const target = [...root.querySelectorAll<HTMLElement>("button, [tabindex], .DialogButton")].find((el) =>
        /go live/i.test(el.textContent || "")
      );
      try {
        target?.focus();
      } catch (_) {}
    }, 150);
    return () => clearTimeout(t);
  }, [voice?.channel_id]);

  if (!voice) {
    return (
      <PanelSectionRow>
        <div style={{ fontSize: "12px", opacity: 0.7 }}>
          Not in a call. Join a voice channel from Servers or call someone from Friends.
        </div>
      </PanelSectionRow>
    );
  }
  return (
    <div ref={anchor}>
      <PanelSectionRow>
        <div style={{ width: "100%", minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: "15px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            🔊 {voice.channel_name}
          </div>
          <div style={{ fontSize: "12px", opacity: 0.7, marginBottom: "6px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {voice.guild_name} · {voice.members.length} in call
          </div>
        </div>
      </PanelSectionRow>
      {voice.members.map((m) => (
        <MemberItem
          key={m.id}
          m={m}
          isMe={m.id === voice.me}
          can={voice.can}
          inServer={!!voice.guild_id}
          open={openId === m.id}
          onToggle={() => setOpenId(openId === m.id ? null : m.id)}
        />
      ))}
      <PipControls />
      <CallHealth />
      <GoLivePanel inCall />
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => call("disconnect_vc")}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", color: "#ff6b6b" }}>
            <FaPhoneSlash /> Disconnect
          </span>
        </ButtonItem>
      </PanelSectionRow>
    </div>
  );
}

// One line on whether audio is really flowing, so a silent call is obvious
// right away instead of after asking "can you hear me?".
function CallHealth() {
  const [h, setH] = useState<{ state: string; detail: string } | null>(null);
  useEffect(() => {
    const load = () => call<[], { state: string; detail: string }>("get_call_health").then(setH).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);
  if (!h || h.state === "off") return null;
  const color = h.state === "ok" ? "#23a55a" : h.state === "pending" ? "#b5bac1" : h.state === "warn" ? "#f0b232" : "#ed4245";
  return (
    <PanelSectionRow>
      <div style={{ fontSize: "11px", color, wordBreak: "break-word" }}>{h.detail}</div>
    </PanelSectionRow>
  );
}

// The red Discord uses for moderator actions in its menus.
const ADMIN = "#f23f43";

const VOLUMES = Array.from({ length: 21 }, (_, i) => i * 10).map((v) => ({
  value: v,
  short: v === 0 || v === 100 || v === 200 ? `${v}%` : "",
  label: `${v}%`,
}));

// Someone in your call: select (A) for their controls.
function MemberItem({
  m,
  isMe,
  can,
  inServer,
  open,
  onToggle,
}: {
  m: Member;
  isMe: boolean;
  inServer: boolean;
  can?: { mute: boolean; deafen: boolean; move: boolean };
  open: boolean;
  onToggle: () => void;
}) {
  const [confirmKick, setConfirmKick] = useState(false);
  useEffect(() => {
    if (!confirmKick) return;
    const t = setTimeout(() => setConfirmKick(false), 4000);
    return () => clearTimeout(t);
  }, [confirmKick]);

  const run = async (method: string, ...args: any[]) => {
    const res: any = await call(method as any, ...args);
    if (res?.error) toaster.toast({ title: "Discordio", body: res.error });
    return res;
  };

  return (
    <>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={onToggle} disabled={isMe}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, textAlign: "left" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <MemberRow m={m} />
            </div>
            {m.local_muted && <span style={{ fontSize: 10, opacity: 0.7 }}>locally muted</span>}
            {!isMe && m.volume !== undefined && m.volume !== 100 && <span style={{ fontSize: 10, opacity: 0.7 }}>{m.volume}%</span>}
            {!isMe && <span style={{ opacity: 0.5 }}>{open ? "▾" : "▸"}</span>}
          </div>
        </ButtonItem>
      </PanelSectionRow>
      {open && !isMe && (
        <Focusable style={{ paddingLeft: 12, borderLeft: "2px solid rgba(255,255,255,0.15)", marginLeft: 4 }}>
          <PanelSectionRow>
            <div data-dio-key={`member:${m.id}`}>
              <ButtonItem layout="below" onClick={() => openProfile(m.id, `member:${m.id}`)}>
                View Profile
              </ButtonItem>
            </div>
          </PanelSectionRow>
          {m.live && (
            <PanelSectionRow>
              <ButtonItem layout="below" onClick={() => watchStream(m.id, m.name)}>
                Watch Stream
              </ButtonItem>
            </PanelSectionRow>
          )}
          {m.live && (
            <PanelSectionRow>
              <ButtonItem layout="below" description="A small picture over your game, so you can keep playing" onClick={() => watchInOverlay(m.id, m.name)}>
                Watch in Overlay
              </ButtonItem>
            </PanelSectionRow>
          )}
          <PanelSectionRow>
            <ToggleField
              label="Local Mute"
              description="Only you stop hearing them"
              checked={!!m.local_muted}
              onChange={(v) => run("set_local_mute", m.id, v)}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <ChoiceSlider
              label="Voice Volume"
              choices={VOLUMES}
              value={Math.round((m.volume ?? 100) / 10) * 10}
              onChange={(v) => run("set_user_volume", m.id, v)}
            />
          </PanelSectionRow>
          {can?.mute && (
            <PanelSectionRow>
              <ToggleField
                label={<span style={{ color: ADMIN }}>Server Mute</span>}
                description="Nobody in the server hears them"
                checked={!!m.server_muted}
                onChange={(v) => run("moderate", m.id, "mute", v)}
              />
            </PanelSectionRow>
          )}
          {can?.deafen && (
            <PanelSectionRow>
              <ToggleField
                label={<span style={{ color: ADMIN }}>Server Deafen</span>}
                description="They can't hear anyone in the server"
                checked={!!m.server_deafened}
                onChange={(v) => run("moderate", m.id, "deafen", v)}
              />
            </PanelSectionRow>
          )}
          {can?.move && (
            <PanelSectionRow>
              <ButtonItem
                layout="below"
                onClick={async () => {
                  if (!confirmKick) return setConfirmKick(true);
                  setConfirmKick(false);
                  const res = await run("moderate", m.id, "disconnect");
                  if (!res?.error) toaster.toast({ title: "Discordio", body: `Disconnected ${m.name}` });
                }}
              >
                <span style={{ color: ADMIN }}>{confirmKick ? `Press again to disconnect ${m.name}` : "Server Disconnect"}</span>
              </ButtonItem>
            </PanelSectionRow>
          )}
          {inServer && !can?.mute && !can?.deafen && !can?.move && (
            <PanelSectionRow>
              <div style={{ fontSize: 11, opacity: 0.6 }}>Server mute, deafen and disconnect need moderator permissions here.</div>
            </PanelSectionRow>
          )}
        </Focusable>
      )}
    </>
  );
}
