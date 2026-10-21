import { addEventListener, call, removeEventListener, toaster } from "@decky/api";
import { ButtonItem, DialogButton, Focusable, PanelSectionRow, TextField, ToggleField } from "@decky/ui";
import { useEffect, useRef, useState } from "react";
import { FaPhone } from "react-icons/fa";
import { fire, on } from "../lib/events";
import { ColorButton } from "./ColorButton";
import { Avatar } from "./VoiceChatViews";
import { ChoiceSlider } from "./ChoiceSlider";

type Conversation = {
  channel_id: string;
  label: string;
  is_dm: boolean;
  avatar: string | null;
  unread: number;
  last?: { author: string; text: string; time: number };
};
type Media = { kind: "image" | "gif" | "gifv" | "video" | "sticker" | "file"; url?: string; poster?: string; name?: string; title?: string; width?: number; height?: number };
type Message = { id: string; author: { id: string; name: string; avatar: string | null }; text: string; time: number; mine: boolean; media?: Media[] };
type History = { channel_id: string; label: string; messages: Message[]; error?: string };

const small = { fontSize: "12px", lineHeight: "16px", wordBreak: "break-word" as const };
const ago = (t: number) => {
  const s = Math.max(0, Date.now() / 1000 - t);
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};

// Open a conversation from elsewhere (e.g. a friend's Message button). The
// Messages section may be collapsed (unmounted), so the request is kept
// until the panel mounts.
let pendingOpen: Conversation | null = null;
export async function openConversationWith(friend: { id: string; name: string; avatar: string | null }) {
  const res: any = await call("open_dm", friend.id);
  if (!res || res.error) {
    toaster.toast({ title: "Discordio", body: `Couldn't open the conversation: ${res?.error || "no answer"}` });
    return;
  }
  pendingOpen = { channel_id: res.channel_id, label: friend.name, is_dm: true, avatar: friend.avatar, unread: 0 };
  fire("expand:Messages");
  fire("open-conversation");
}

// Open a server text channel in the Messages section.
export function openChannelConversation(ch: { id: string; name: string; guild?: string }) {
  pendingOpen = { channel_id: ch.id, label: `#${ch.name}${ch.guild ? ` · ${ch.guild}` : ""}`, is_dm: false, avatar: null, unread: 0 };
  fire("expand:Messages");
  fire("open-conversation");
}

// DMs and mentions that came in: open one to read and reply.
export function MessagesPanel() {
  const [convs, setConvs] = useState<Conversation[] | null>(null);
  const [open, setOpen] = useState<Conversation | null>(() => {
    const p = pendingOpen;
    pendingOpen = null;
    return p;
  });
  useEffect(
    () =>
      on("open-conversation", () => {
        if (pendingOpen) {
          setOpen(pendingOpen);
          pendingOpen = null;
        }
      }),
    []
  );

  const load = () =>
    call<[], { conversations: Conversation[] }>("get_conversations")
      .then((r) => setConvs(r?.conversations ?? []))
      .catch(() => setConvs([]));

  useEffect(() => {
    load();
    const onMsg = () => load();
    addEventListener("message", onMsg);
    const t = setInterval(load, 4000);
    return () => {
      clearInterval(t);
      removeEventListener("message", onMsg);
    };
  }, []);

  if (open) return <ConversationView conv={open} onBack={() => { setOpen(null); load(); }} />;

  if (!convs) return <Hint>Loading...</Hint>;
  if (convs.length === 0) return <Hint>No new messages. DMs and mentions show up here and as popups over your game.</Hint>;

  return (
    <>
      {convs.map((c) => (
        <PanelSectionRow key={c.channel_id}>
          <ButtonItem
            layout="below"
            onClick={() => setOpen(c)}
          >
            <span style={{ display: "flex", gap: "8px", alignItems: "center", textAlign: "left", minWidth: 0 }}>
              <Avatar src={c.avatar} size={30} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <b style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.label}</b>
                  {c.unread > 0 && (
                    <span style={{ background: "#ed4245", color: "#fff", borderRadius: 8, fontSize: 10, padding: "0 6px", fontWeight: 700 }}>
                      {c.unread}
                    </span>
                  )}
                  {c.last && <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.6 }}>{ago(c.last.time)}</span>}
                </span>
                {c.last && (
                  <span style={{ display: "block", fontSize: 12, opacity: 0.8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {c.is_dm ? "" : `${c.last.author}: `}
                    {c.last.text}
                  </span>
                )}
              </span>
            </span>
          </ButtonItem>
        </PanelSectionRow>
      ))}
    </>
  );
}

function ConversationView({ conv, onBack }: { conv: Conversation; onBack: () => void }) {
  const [history, setHistory] = useState<History | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const top = useRef<HTMLDivElement>(null);

  // Opening a conversation brings it into view.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        top.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (_) {}
    }, 150);
    return () => clearTimeout(t);
  }, [conv.channel_id]);

  const load = () =>
    call<[string], History>("get_history", conv.channel_id)
      .then(setHistory)
      .catch((e) => setHistory({ channel_id: conv.channel_id, label: conv.label, messages: [], error: String(e) }));

  useEffect(() => {
    load();
    const onMsg = (m: any) => m?.channel_id === conv.channel_id && load();
    addEventListener("message", onMsg);
    // Discord's message store answers instantly, so a short poll keeps the
    // conversation live for messages that don't raise a notification
    // (your own, and replies in a server channel that don't mention you).
    const t = setInterval(load, 2000);
    return () => {
      clearInterval(t);
      removeEventListener("message", onMsg);
    };
  }, [conv.channel_id]);

  const send = async () => {
    if (!text.trim()) return;
    setSending(true);
    try {
      const res: any = await call("send_message", conv.channel_id, text);
      if (res?.error) toaster.toast({ title: "Discordio", body: `Not sent: ${res.error}` });
      else {
        setText("");
        load();
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <PanelSectionRow>
        <div ref={top}>
          <Focusable style={{ display: "flex", gap: "8px" }}>
            <DialogButton style={{ flex: 1, minWidth: 0 }} onClick={onBack}>
              ← Messages
            </DialogButton>
            {conv.is_dm && <ColorButton color="#23a55a" onClick={async () => {
                const res: any = await call("call_channel", conv.channel_id);
                toaster.toast({ title: "Discordio", body: res?.error ? `Couldn't call: ${res.error}` : `Calling ${history?.label || conv.label}` });
                if (!res?.error) fire("collapse:Messages");
              }}>
              <FaPhone /> Call
            </ColorButton>}
          </Focusable>
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{history?.label || conv.label}</div>
      </PanelSectionRow>
      {!history && <Hint>Loading messages...</Hint>}
      {history?.error && <Hint error>{history.error}</Hint>}
      {history?.messages.slice(-20).map((m) => (
        <PanelSectionRow key={m.id}>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", ...small }}>
            <Avatar src={m.author.avatar} size={22} />
            <div style={{ minWidth: 0 }}>
              <b style={{ color: m.mine ? "#949cf7" : undefined }}>{m.author.name}</b>{" "}
              <span style={{ opacity: 0.5, fontSize: 10 }}>{ago(m.time / 1000)}</span>
              {m.text ? <div>{m.text}</div> : !m.media?.length && <i style={{ opacity: 0.6 }}>(no text)</i>}
              {m.media?.map((x, i) => <MediaView key={i} m={x} />)}
            </div>
          </div>
        </PanelSectionRow>
      ))}
      <PanelSectionRow>
        {/* Selecting the field with A opens Steam's on-screen keyboard. */}
        <TextField
          label="Reply"
          value={text}
          disabled={sending}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e: any) => e.key === "Enter" && send()}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={sending || !text.trim()} onClick={send}>
          {sending ? "Sending..." : "Send"}
        </ButtonItem>
      </PanelSectionRow>
    </>
  );
}

const POSITIONS = [
  { value: "top-left", short: "TL", label: "Top left" },
  { value: "top-right", short: "TR", label: "Top right" },
  { value: "bottom-left", short: "BL", label: "Bottom left" },
  { value: "bottom-right", short: "BR", label: "Bottom right" },
];
const DURATIONS = [4, 8, 15, 30].map((d) => ({ value: d, short: `${d}s`, label: `${d} seconds` }));

type MessageSettings = { popups: boolean; position: string; duration: number };

// Settings for message popups (shown by the in-game overlay).
export function MessageSettingsPanel() {
  const [s, setS] = useState<MessageSettings | null>(null);
  useEffect(() => {
    call<[], MessageSettings>("get_message_settings").then(setS).catch(() => {});
  }, []);
  const update = async (popups?: boolean, position?: string, duration?: number) =>
    setS(await call<[boolean | null, string | null, number | null], MessageSettings>(
      "set_message_settings", popups ?? null, position ?? null, duration ?? null));
  if (!s) return null;
  return (
    <>
      <PanelSectionRow>
        <ToggleField
          label="Message popups"
          description="DMs and mentions pop up over your game (needs the in-game overlay on)"
          checked={s.popups}
          onChange={(v) => update(v)}
        />
      </PanelSectionRow>
      {s.popups && (
        <>
          <PanelSectionRow>
            <ChoiceSlider label="Popup position" choices={POSITIONS} value={s.position} onChange={(v) => update(undefined, v)} />
          </PanelSectionRow>
          <PanelSectionRow>
            <ChoiceSlider label="Show popups for" choices={DURATIONS} value={s.duration} onChange={(v) => update(undefined, undefined, v)} />
          </PanelSectionRow>
        </>
      )}
    </>
  );
}

const Hint = ({ children, error }: { children: any; error?: boolean }) => (
  <PanelSectionRow>
    <div style={{ ...small, opacity: error ? 1 : 0.7, color: error ? "#ff6b6b" : undefined }}>{children}</div>
  </PanelSectionRow>
);

// Pictures, GIFs, videos and stickers, like in Discord.
function MediaView({ m }: { m: Media }) {
  const box = { display: "block", maxWidth: "100%", maxHeight: 170, borderRadius: 6, marginTop: 4 } as const;
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  if (m.kind === "file" || !m.url) return <div style={{ opacity: 0.7, marginTop: 2 }}>📎 {m.name || "file"}</div>;
  if (m.kind === "image" || m.kind === "gif" || m.kind === "sticker") {
    return <img src={m.url} loading="lazy" style={{ ...box, maxHeight: m.kind === "sticker" ? 96 : 170 }} />;
  }
  if (m.kind === "gifv") {
    return <video src={m.url} poster={m.poster} autoPlay loop muted playsInline style={box} />;
  }
  // Videos: select with A to play / pause (with sound).
  return (
    <Focusable
      onActivate={() => {
        const v = video.current;
        if (!v) return;
        if (v.paused) {
          v.muted = false;
          v.play().catch(() => {});
        } else v.pause();
      }}
      onOKActionDescription={playing ? "Pause" : "Play"}
      style={{ position: "relative", display: "inline-block", maxWidth: "100%" }}
    >
      <video
        ref={video}
        src={m.url}
        poster={m.poster}
        preload="metadata"
        playsInline
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        style={box}
      />
      {!playing && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, textShadow: "0 0 6px #000" }}>
          ▶
        </div>
      )}
    </Focusable>
  );
}
