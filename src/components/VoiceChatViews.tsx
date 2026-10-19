import { call } from "@decky/api";
import { PanelSectionRow } from "@decky/ui";
import { useEffect, useState } from "react";
import { FaMicrophoneSlash, FaVolumeMute, FaVideo } from "react-icons/fa";
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
        .then((v) => alive && setVoice(v && !v.error ? v : null))
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

export function VoiceChannelView() {
  const voice = useVoice();
  if (!voice) {
    return (
      <PanelSectionRow>
        <div style={{ fontSize: "12px", opacity: 0.7 }}>Not in a voice channel</div>
      </PanelSectionRow>
    );
  }
  return (
    <PanelSectionRow>
      <div style={{ width: "100%", minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: "15px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          🔊 {voice.channel_name}
        </div>
        <div style={{ fontSize: "12px", opacity: 0.7, marginBottom: "6px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {voice.guild_name}
        </div>
        {voice.members.map((m) => (
          <MemberRow key={m.id} m={m} />
        ))}
      </div>
    </PanelSectionRow>
  );
}
