import { addEventListener, call, removeEventListener, toaster } from "@decky/api";
import { ButtonItem, PanelSectionRow, TextField, ToggleField } from "@decky/ui";
import { useEffect, useState } from "react";
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
type Message = { id: string; author: { id: string; name: string; avatar: string | null }; text: string; time: number; mine: boolean };
type History = { channel_id: string; label: string; messages: Message[]; error?: string };

const small = { fontSize: "12px", lineHeight: "16px", wordBreak: "break-word" as const };
const ago = (t: number) => {
  const s = Math.max(0, Date.now() / 1000 - t);
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};

// DMs and mentions that came in: open one to read and reply.
export function MessagesPanel() {
  const [convs, setConvs] = useState<Conversation[] | null>(null);
  const [open, setOpen] = useState<Conversation | null>(null);

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
        <ButtonItem layout="below" onClick={onBack}>
          ← Messages
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{history?.label || conv.label}</div>
      </PanelSectionRow>
      {!history && <Hint>Loading messages...</Hint>}
      {history?.error && <Hint error>{history.error}</Hint>}
      {history?.messages.slice(-12).map((m) => (
        <PanelSectionRow key={m.id}>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", ...small }}>
            <Avatar src={m.author.avatar} size={22} />
            <div style={{ minWidth: 0 }}>
              <b style={{ color: m.mine ? "#949cf7" : undefined }}>{m.author.name}</b>{" "}
              <span style={{ opacity: 0.5, fontSize: 10 }}>{ago(m.time / 1000)}</span>
              <div>{m.text || <i style={{ opacity: 0.6 }}>(no text)</i>}</div>
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
