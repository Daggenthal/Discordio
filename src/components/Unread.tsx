import { call, toaster } from "@decky/api";
import { DialogButton, Focusable, PanelSectionRow } from "@decky/ui";

// Discord-style unread markers: a red count for mentions, a grey count (or
// dot) for other unread messages. Muted things stay quiet.
export function UnreadBadge({ unread, mentions, muted }: { unread?: number | boolean; mentions?: number; muted?: boolean }) {
  if (mentions && mentions > 0) {
    return (
      <span style={{ background: "#ed4245", color: "#fff", borderRadius: 8, fontSize: 10, padding: "0 6px", fontWeight: 700, flex: "none" }}>
        {mentions > 99 ? "99+" : mentions}
      </span>
    );
  }
  if (!unread || muted) return null;
  if (typeof unread === "number" && unread > 1) {
    return (
      <span style={{ background: "rgba(255,255,255,0.85)", color: "#111", borderRadius: 8, fontSize: 10, padding: "0 6px", fontWeight: 700, flex: "none" }}>
        {unread > 99 ? "99+" : unread}
      </span>
    );
  }
  return <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#fff", display: "inline-block", flex: "none" }} />;
}

export const MutedIcon = () => <span style={{ fontSize: 11, opacity: 0.6, flex: "none" }}>🔕</span>;

export async function markRead(channelIds: string[], guildId?: string, label?: string) {
  const res: any = await call("mark_read", channelIds, guildId ?? null);
  toaster.toast({ title: "Discordio", body: res?.error ? `Couldn't mark as read: ${res.error}` : `${label ?? "Marked"} as read` });
  return !res?.error;
}

export async function setPopupMute(kind: "guild" | "channel", id: string, name: string, muted: boolean) {
  await call("set_popup_mute", kind, id, name, muted);
  toaster.toast({ title: "Discordio", body: muted ? `No more popups from ${name}` : `Popups from ${name} are back on` });
}

// The small row of actions shown when you press Options on a server or conversation.
export function ActionRow({ actions }: { actions: { label: string; onClick: () => void }[] }) {
  return (
    <PanelSectionRow>
      <div style={{ padding: "4px 0 8px" }}>
        <Focusable style={{ display: "flex", gap: 8 }}>
          {actions.map((a) => (
            <DialogButton key={a.label} style={{ flex: 1, minWidth: 0, height: "auto", minHeight: 40, lineHeight: 1.25, fontSize: 13 }} onClick={a.onClick}>
              {a.label}
            </DialogButton>
          ))}
        </Focusable>
      </div>
    </PanelSectionRow>
  );
}
