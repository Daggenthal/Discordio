import { addEventListener, call, removeEventListener, toaster } from "@decky/api";
import { ButtonItem, DialogButton, Focusable, PanelSectionRow, TextField, ToggleField } from "@decky/ui";
import { useEffect, useRef, useState } from "react";
import { FaPhone } from "react-icons/fa";
import { fire, on, remember, restored as restoredState } from "../lib/events";
import { Shot, ShotGrid } from "./UploadScreenshot";
import { Emoji, EmojiPicker } from "./EmojiPicker";
import { GifPicker } from "./GifPicker";
import { openViewer, takeRestore } from "../lib/viewer";
import { ActionRow, MutedIcon, UnreadBadge, markRead, setPopupMute } from "./Unread";
import { ColorButton } from "./ColorButton";
import { Avatar } from "./VoiceChatViews";
import { ChoiceSlider } from "./ChoiceSlider";

type Conversation = {
  channel_id: string;
  label: string;
  is_dm: boolean;
  avatar: string | null;
  unread: number;
  mentions?: number;
  muted?: boolean; // muted in Discord
  popups_muted?: boolean; // muted for popups in Discordio
  last?: { author: string; text: string; time: number };
};
type Media = { kind: "image" | "gif" | "gifv" | "video" | "sticker" | "file"; url?: string; poster?: string; name?: string; title?: string; width?: number; height?: number };
type Reaction = { emoji: string | null; name: string; id: string | null; url: string | null; count: number; me: boolean };
type Message = {
  id: string;
  author: { id: string; name: string; avatar: string | null };
  text: string;
  time: number;
  mine: boolean;
  media?: Media[];
  reactions?: Reaction[];
  replyTo?: { id: string; name: string | null; text: string } | null;
  edited?: boolean;
};
type History = { channel_id: string; label: string; messages: Message[]; error?: string; typing?: string[] };

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
  // Back from the full-screen viewer: the same conversation, same message.
  const [restored] = useState(() => takeRestore());
  const [open, setOpenRaw] = useState<Conversation | null>(() => {
    const back = restoredState<Conversation | null>("conversation");
    if (back) return back;
    if (restored) return restored.conv;
    const p = pendingOpen;
    pendingOpen = null;
    return p;
  });
  const setOpen = (c: Conversation | null) => {
    remember("conversation", c);
    setOpenRaw(c);
  };
  useEffect(() => {
    remember("conversation", open);
  }, []);
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

  const [actionsFor, setActionsFor] = useState<string | null>(null);
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

  if (open) return <ConversationView conv={open} focusMessage={restored?.conv === open ? restored.messageId : undefined} onBack={() => { setOpen(null); load(); }} />;

  if (!convs) return <Hint>Loading...</Hint>;
  if (convs.length === 0) return <Hint>No new messages. DMs and mentions show up here and as popups over your game.</Hint>;

  const anyUnread = convs.some((c) => c.unread > 0);
  return (
    <>
      {anyUnread && (
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={async () => {
              const res: any = await call("mark_all_read");
              toaster.toast({ title: "Discordio", body: res?.error ? `Couldn't mark as read: ${res.error}` : "All caught up" });
              load();
            }}
          >
            Mark All as Read
          </ButtonItem>
        </PanelSectionRow>
      )}
      {convs.map((c) => (
        <div key={c.channel_id}>
        <PanelSectionRow>
          <Focusable
            onOptionsButton={() => setActionsFor(actionsFor === c.channel_id ? null : c.channel_id)}
            onOptionsActionDescription="More"
          >
          <ButtonItem
            layout="below"
            onClick={() => setOpen(c)}
          >
            <span style={{ display: "flex", gap: "8px", alignItems: "center", textAlign: "left", minWidth: 0 }}>
              <Avatar src={c.avatar} size={30} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <b style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: c.unread > 0 || c.mentions ? 1 : 0.85 }}>
                    {c.label}
                  </b>
                  <UnreadBadge unread={c.unread} mentions={c.mentions} />
                  {(c.muted || c.popups_muted) && <MutedIcon />}
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
          </Focusable>
        </PanelSectionRow>
        {actionsFor === c.channel_id && (
          <ActionRow
            actions={[
              { label: "Mark as Read", onClick: async () => { await markRead([c.channel_id], undefined, c.label); setActionsFor(null); load(); } },
              {
                label: c.popups_muted ? "Unmute Popups" : "Mute Popups",
                onClick: async () => { await setPopupMute("channel", c.channel_id, c.label, !c.popups_muted); setActionsFor(null); load(); },
              },
            ]}
          />
        )}
        </div>
      ))}
      <Hint>Press Options on a conversation to mark it read or mute its popups.</Hint>
    </>
  );
}

function ConversationView({ conv, onBack, focusMessage }: { conv: Conversation; onBack: () => void; focusMessage?: string }) {
  const [history, setHistory] = useState<History | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const [shots, setShots] = useState(false);
  const [gifs, setGifs] = useState(false);
  const [replyTo, setReplyTo] = useState<{ id: string; name: string; text: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string; before: string } | null>(null);
  const top = useRef<HTMLDivElement>(null);
  const reply = useRef<HTMLDivElement>(null);

  // Move the controller's focus as well as the view, so the next press
  // continues from there instead of snapping back.
  const focusIn = (el: HTMLElement | null) => {
    try {
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      el?.querySelector<HTMLElement>("input, button, .DialogButton")?.focus();
    } catch (_) {}
  };
  const jumpToReply = () => focusIn(reply.current);
  const jumpToTop = () => focusIn(top.current);

  // Opening a conversation brings it into view (or, back from the viewer,
  // the message you were on).
  const focused = useRef(false);
  useEffect(() => {
    if (!focusMessage || focused.current || !history) return;
    focused.current = true;
    setTimeout(() => {
      try {
        const el = document.getElementById(`dio-msg-${focusMessage}`);
        el?.scrollIntoView({ block: "center" });
        (el?.closest("[tabindex]") as HTMLElement | null)?.focus();
      } catch (_) {}
    }, 200);
  }, [history]);
  useEffect(() => {
    if (focusMessage) return;
    const t = setTimeout(() => {
      try {
        top.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (_) {}
    }, 150);
    return () => clearTimeout(t);
  }, [conv.channel_id]);

  const lastAcked = useRef<string | null>(null);
  const load = () =>
    call<[string], History>("get_history", conv.channel_id)
      .then((h) => {
        setHistory(h);
        // Reading it here counts as reading it in Discord.
        const last = h?.messages?.[h.messages.length - 1]?.id;
        if (last && last !== lastAcked.current) {
          lastAcked.current = last;
          call("mark_read", [conv.channel_id], null).catch(() => {});
        }
      })
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
    if (editing) {
      try {
        const res: any = await call("edit_message", conv.channel_id, editing.id, text);
        if (res?.error) toaster.toast({ title: "Discordio", body: `Not saved: ${res.error}` });
        else {
          setText(editing.before);
          setEditing(null);
          load();
        }
      } finally {
        setSending(false);
      }
      return;
    }
    try {
      const res: any = await call("send_message", conv.channel_id, text, replyTo?.id ?? null);
      if (res?.error) toaster.toast({ title: "Discordio", body: `Not sent: ${res.error}` });
      else {
        setText("");
        setReplyTo(null);
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
          <div style={{ padding: "6px 0" }}><Focusable style={{ display: "flex", gap: "8px" }}>
            <DialogButton style={{ flex: 1, minWidth: 0, height: "auto", minHeight: 44, lineHeight: 1.25 }} onClick={onBack}>
              ← Messages
            </DialogButton>
            {conv.is_dm && <ColorButton color="#23a55a" onClick={async () => {
                const res: any = await call("call_channel", conv.channel_id);
                toaster.toast({ title: "Discordio", body: res?.error ? `Couldn't call: ${res.error}` : `Calling ${history?.label || conv.label}` });
                if (!res?.error) fire("collapse:Messages");
              }}>
              <FaPhone /> Call
            </ColorButton>}
          </Focusable></div>
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={jumpToReply}>
          Jump to Reply ↓
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{history?.label || conv.label}</div>
      </PanelSectionRow>
      {!history && <Hint>Loading messages...</Hint>}
      {history?.error && <Hint error>{history.error}</Hint>}
      {history?.messages.slice(-20).map((m) => (
        <MessageRow
          key={m.id}
          conv={conv}
          m={m}
          channelId={conv.channel_id}
          picking={picking === m.id}
          onPick={() => setPicking(picking === m.id ? null : m.id)}
          onReacted={() => {
            setPicking(null);
            load();
          }}
          onReply={() => {
            setPicking(null);
            setEditing(null);
            setReplyTo({ id: m.id, name: m.author.name, text: m.text || (m.media?.length ? "(attachment)" : "") });
            setTimeout(jumpToReply, 100);
          }}
          onEdit={() => {
            setPicking(null);
            setReplyTo(null);
            setEditing({ id: m.id, before: text });
            setText(m.text);
            setTimeout(jumpToReply, 100);
          }}
          onDelete={async () => {
            setPicking(null);
            const res: any = await call("delete_message", conv.channel_id, m.id);
            toaster.toast({ title: "Discordio", body: res?.error ? `Couldn't delete: ${res.error}` : "Message deleted" });
            load();
          }}
        />
      ))}
      {!!history?.typing?.length && (
        <PanelSectionRow>
          <div style={{ ...small, opacity: 0.7, fontStyle: "italic" }}>
            {history.typing.join(", ")} {history.typing.length > 1 ? "are" : "is"} typing...
          </div>
        </PanelSectionRow>
      )}
      {editing && (
        <PanelSectionRow>
          <Focusable style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0, ...small, opacity: 0.8 }}>✎ Editing your message</div>
            <DialogButton style={{ minWidth: 0, width: "auto", padding: "4px 12px" }} onClick={() => { setText(editing.before); setEditing(null); }}>
              Cancel
            </DialogButton>
          </Focusable>
        </PanelSectionRow>
      )}
      {replyTo && (
        <PanelSectionRow>
          <Focusable style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0, ...small, opacity: 0.8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              ↩ Replying to <b>{replyTo.name}</b>{replyTo.text ? `: ${replyTo.text}` : ""}
            </div>
            <DialogButton style={{ minWidth: 0, width: "auto", padding: "4px 12px" }} onClick={() => setReplyTo(null)}>
              Cancel
            </DialogButton>
          </Focusable>
        </PanelSectionRow>
      )}
      <PanelSectionRow>
        {/* Selecting the field with A opens Steam's on-screen keyboard. */}
        <div ref={reply}>
        <TextField
          label="Reply"
          value={text}
          disabled={sending}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e: any) => e.key === "Enter" && send()}
        />
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={sending || !text.trim()} onClick={send}>
          {sending ? (editing ? "Saving..." : "Sending...") : editing ? "Save Edit" : "Send"}
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <div style={{ padding: "6px 0" }}><Focusable style={{ display: "flex", gap: "8px" }}>
          <DialogButton style={{ flex: 1, minWidth: 0, height: "auto", minHeight: 44, lineHeight: 1.25 }} onClick={() => { setGifs(!gifs); setShots(false); }}>
            {gifs ? "Close GIFs" : "GIF"}
          </DialogButton>
          <DialogButton style={{ flex: 2, minWidth: 0, height: "auto", minHeight: 44, lineHeight: 1.25 }} onClick={() => { setShots(!shots); setGifs(false); }}>
            {shots ? "Cancel Screenshot" : "📷 Screenshot"}
          </DialogButton>
        </Focusable></div>
      </PanelSectionRow>
      {gifs && (
        <GifPicker
          onClose={() => setGifs(false)}
          onPick={async (g) => {
            setGifs(false);
            const res: any = await call("send_message", conv.channel_id, g.url, replyTo?.id ?? null);
            toaster.toast({ title: "Discordio", body: res?.error ? `Not sent: ${res.error}` : "GIF sent" });
            if (!res?.error) {
              setReplyTo(null);
              load();
            }
          }}
        />
      )}
      <PanelSectionRow>
        <div style={{ padding: "6px 0" }}><Focusable style={{ display: "flex", gap: "8px" }}>
          <DialogButton style={{ flex: 1, minWidth: 0, height: "auto", minHeight: 44, lineHeight: 1.25 }} onClick={jumpToTop}>
            ↑ Back to Top
          </DialogButton>
          <DialogButton style={{ flex: 1, minWidth: 0, height: "auto", minHeight: 44, lineHeight: 1.25 }} onClick={() => fire("collapse:Messages")}>
            Collapse Messages
          </DialogButton>
        </Focusable></div>
      </PanelSectionRow>
      {shots && (
        <ShotGrid
          selected={null}
          onPick={async (sh: Shot) => {
            setShots(false);
            toaster.toast({ title: "Discordio", body: "Sending screenshot, one moment..." });
            const res: any = await call("post_screenshot_file", sh.id, conv.channel_id, null);
            toaster.toast({ title: "Discordio", body: res?.error ? `Not sent: ${res.error}` : "Screenshot sent" });
            if (!res?.error) load();
          }}
        />
      )}
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

type MessageSettings = {
  popups: boolean; position: string; duration: number; dms?: boolean; mentions?: boolean; follow_discord?: boolean;
  muted_guilds?: Record<string, string>; muted_channels?: Record<string, string>;
};

// Settings for message popups (shown by the in-game overlay).
export function MessageSettingsPanel() {
  const [s, setS] = useState<MessageSettings | null>(null);
  useEffect(() => {
    call<[], MessageSettings>("get_message_settings").then(setS).catch(() => {});
  }, []);
  const update = async (popups?: boolean, position?: string, duration?: number, extra: { dms?: boolean; mentions?: boolean; follow?: boolean } = {}) =>
    setS(await call<any[], MessageSettings>(
      "set_message_settings", popups ?? null, position ?? null, duration ?? null, extra.dms ?? null, extra.mentions ?? null, extra.follow ?? null));
  const unmute = async (kind: "guild" | "channel", id: string) => setS(await call<any[], MessageSettings>("set_popup_mute", kind, id, null, false));
  const muted = [
    ...Object.entries(s?.muted_guilds || {}).map(([id, name]) => ({ kind: "guild" as const, id, name })),
    ...Object.entries(s?.muted_channels || {}).map(([id, name]) => ({ kind: "channel" as const, id, name })),
  ];
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
          <PanelSectionRow>
            <ToggleField label="Direct Messages" description="Pop up when someone DMs you" checked={s.dms !== false}
              onChange={(v) => update(undefined, undefined, undefined, { dms: v })} />
          </PanelSectionRow>
          <PanelSectionRow>
            <ToggleField label="Server Mentions" description="Pop up when someone @mentions you in a server" checked={s.mentions !== false}
              onChange={(v) => update(undefined, undefined, undefined, { mentions: v })} />
          </PanelSectionRow>
          <PanelSectionRow>
            <ToggleField label="Follow Discord's Mutes" description="No popups from servers and channels you muted in Discord" checked={s.follow_discord !== false}
              onChange={(v) => update(undefined, undefined, undefined, { follow: v })} />
          </PanelSectionRow>
          {muted.length > 0 && (
            <>
              <PanelSectionRow>
                <div style={{ ...small, opacity: 0.7 }}>Muted in Discordio (press Options on a server, channel or conversation to mute it):</div>
              </PanelSectionRow>
              {muted.map((x) => (
                <PanelSectionRow key={x.kind + x.id}>
                  <ButtonItem layout="inline" label={`🔕 ${x.name}`} onClick={() => unmute(x.kind, x.id)}>
                    Unmute
                  </ButtonItem>
                </PanelSectionRow>
              ))}
            </>
          )}
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


// One message. Select it (A) to react; existing reactions show underneath.
function MessageRow({
  m,
  channelId,
  picking,
  onPick,
  onReacted,
  onReply,
  onEdit,
  onDelete,
  conv,
}: {
  conv: Conversation;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  m: Message;
  channelId: string;
  picking: boolean;
  onPick: () => void;
  onReacted: () => void;
}) {
  const react = async (e: Emoji, remove: boolean) => {
    const emoji = e.id ? { id: e.id, name: e.name, animated: !!e.animated } : e.emoji ?? e.name;
    const res: any = await call("react", channelId, m.id, emoji, remove);
    if (res?.error) toaster.toast({ title: "Discordio", body: `Couldn't react: ${res.error}` });
    onReacted();
  };
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Steam doesn't highlight or scroll to a plain Focusable, so do both here:
  // without it the selection was invisible and the list jumped in big steps.
  const onFocus = () => {
    setFocused(true);
    try {
      ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } catch (_) {}
  };
  return (
    <>
      <PanelSectionRow>
        <Focusable
          onActivate={onPick}
          onOKActionDescription={picking ? "Close" : "React"}
          {...({ onGamepadFocus: onFocus, onGamepadBlur: () => setFocused(false) } as any)}
        >
          <div
            ref={ref}
            id={`dio-msg-${m.id}`}
            style={{
              display: "flex", gap: 8, alignItems: "flex-start", ...small,
              padding: "4px 6px", margin: "0 -6px", borderRadius: 6,
              background: focused ? "rgba(255,255,255,0.12)" : "transparent",
              outline: focused ? "2px solid rgba(255,255,255,0.7)" : "2px solid transparent",
              scrollMarginBlock: "40px",
            }}
          >
            <Avatar src={m.author.avatar} size={22} />
            <div style={{ minWidth: 0 }}>
              {m.replyTo && (
                <div style={{ opacity: 0.6, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  ↪ {m.replyTo.name ? <b>{m.replyTo.name}</b> : null} {m.replyTo.text}
                </div>
              )}
              <b style={{ color: m.mine ? "#949cf7" : undefined }}>{m.author.name}</b>{" "}
              <span style={{ opacity: 0.5, fontSize: 10 }}>{ago(m.time / 1000)}{m.edited ? " · edited" : ""}</span>
              {m.text ? <div><RichText text={m.text} /></div> : !m.media?.length && <i style={{ opacity: 0.6 }}>(no text)</i>}
              {m.media?.map((x, i) => <MediaView key={i} m={x} />)}
              {!!m.reactions?.length && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                  {m.reactions.map((r, i) => (
                    <span
                      key={i}
                      style={{
                        display: "inline-flex", alignItems: "center", gap: 3, padding: "1px 6px", borderRadius: 8, fontSize: 11,
                        background: r.me ? "rgba(88,101,242,0.35)" : "rgba(255,255,255,0.08)",
                        border: r.me ? "1px solid #5865f2" : "1px solid transparent",
                      }}
                    >
                      {r.url ? <img src={r.url} style={{ width: 14, height: 14 }} /> : r.emoji}
                      {r.count}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Focusable>
      </PanelSectionRow>
      {picking && (
        <EmojiPicker
          channelId={channelId}
          existing={(m.reactions || []).map((r) => ({ id: r.id, name: r.name, emoji: r.emoji, url: r.url, me: r.me }))}
          onPick={react}
          onClose={onPick}
          onReply={onReply}
          onView={m.media?.some((x) => x.url && x.kind !== "file") ? () => openViewer(m.media as any, 0, conv, m.id) : undefined}
          onEdit={m.mine && m.text ? onEdit : undefined}
          onDelete={m.mine ? onDelete : undefined}
        />
      )}
    </>
  );
}

// Message text with Discord's custom emojis drawn (animated ones animate).
// A message that's only emojis shows them bigger, like Discord.
const EMOJI = /<(a?):(\w+):(\d+)>/g;
function RichText({ text }: { text: string }) {
  const parts: any[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const onlyEmoji = text.replace(EMOJI, "").trim() === "";
  const size = onlyEmoji ? 34 : 20;
  EMOJI.lastIndex = 0;
  while ((m = EMOJI.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <img
        key={m.index}
        src={`https://cdn.discordapp.com/emojis/${m[3]}.${m[1] ? "gif" : "webp"}?size=64&quality=lossless`}
        alt={`:${m[2]}:`}
        title={`:${m[2]}:`}
        style={{ width: size, height: size, verticalAlign: onlyEmoji ? "middle" : "-5px", objectFit: "contain", margin: "0 1px" }}
      />
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
