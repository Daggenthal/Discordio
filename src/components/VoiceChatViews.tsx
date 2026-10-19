import { call } from "@decky/api";
import { ButtonItem, PanelSectionRow } from "@decky/ui";
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
};

export type VoiceInfo = {
  channel_id: string;
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
export function VoiceChannelView() {
  const voice = useVoice();
  const anchor = useRef<HTMLDivElement>(null);
  const lastChannel = useRef<string | null | undefined>(undefined);

  // When you join a call (or switch to another), bring the Call section into
  // view and put the controller focus on Go Live, so streaming is one press
  // away instead of buried below the server list.
  useEffect(() => {
    const id = voice?.channel_id ?? null;
    const prev = lastChannel.current;
    lastChannel.current = id;
    if (!id || prev === undefined || prev === id) return;
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
          {voice.members.map((m) => (
            <MemberRow key={m.id} m={m} />
          ))}
        </div>
      </PanelSectionRow>
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
