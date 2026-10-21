import { call, toaster } from "@decky/api";
import { ButtonItem, DialogButton, Focusable, PanelSectionRow, TextField } from "@decky/ui";
import { useEffect, useState } from "react";
import { Emoji, EmojiPicker } from "./EmojiPicker";
import { ChoiceSlider } from "./ChoiceSlider";
import { fire } from "../lib/events";

type StatusEmoji = { url?: string; text?: string; name?: string } | null;

// When the custom status clears, like Discord's choices.
const CLEAR_AFTER: { value: number | string; short: string; label: string }[] = [
  { value: 0, short: "Never", label: "Don't clear" },
  { value: 30, short: "30m", label: "30 minutes" },
  { value: 60, short: "1h", label: "1 hour" },
  { value: 240, short: "4h", label: "4 hours" },
  { value: "today", short: "Today", label: "Today (at midnight)" },
  { value: 1440, short: "1d", label: "24 hours" },
  { value: 4320, short: "3d", label: "3 days" },
  { value: 10080, short: "1w", label: "1 week" },
];

export const STATUSES = [
  { value: "online", label: "Online", color: "#23a55a", hint: "" },
  { value: "idle", label: "Idle", color: "#f0b232", hint: "" },
  { value: "dnd", label: "Do Not Disturb", color: "#f23f43", hint: "Mutes Discordio's message popups" },
  { value: "invisible", label: "Invisible", color: "#80848e", hint: "You'll appear offline" },
];

const Dot = ({ color }: { color: string }) => (
  <span style={{ width: 10, height: 10, borderRadius: "50%", background: color, display: "inline-block", flex: "none" }} />
);

// Your status and custom status, under your name. Select it to change.
export function StatusPanel({ status }: { status?: { status: string; custom: string | null; emoji?: StatusEmoji } | null }) {
  const [open, setOpen] = useState(false);
  // undefined: keep the current emoji; "none": remove it; or a new one.
  const [emoji, setEmoji] = useState<Emoji | "none" | undefined>(undefined);
  const [picking, setPicking] = useState(false);
  const [clearAfter, setClearAfter] = useState<number | string>(0);
  // "Clear Custom Status" needs a second press.
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    if (!confirmClear) return;
    const t = setTimeout(() => setConfirmClear(false), 4000);
    return () => clearTimeout(t);
  }, [confirmClear]);
  const [custom, setCustom] = useState(status?.custom ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) setCustom(status?.custom ?? "");
  }, [status?.custom, open]);

  const current = STATUSES.find((s) => s.value === status?.status) ?? STATUSES[0];
  // What the emoji will be after saving.
  const shown: StatusEmoji =
    emoji === "none" ? null : emoji ? (emoji.url ? { url: emoji.url } : { text: emoji.emoji ?? emoji.name }) : status?.emoji ?? null;
  const set = async (st: string | null, text: string | null, done: string) => {
    setBusy(true);
    try {
      const em = text === null ? null : emoji === undefined ? null : emoji === "none" ? "none" : { id: emoji.id, name: emoji.id ? emoji.name : emoji.emoji ?? emoji.name };
      const res: any = await call("set_status", st, text, em, text === null ? null : clearAfter);
      if (!res?.error && text !== null) {
        setEmoji(undefined);
        setPicking(false);
        setOpen(false); // done: back to the top of Discordio
        setTimeout(() => fire("jump:top"), 60);
      }
      toaster.toast({ title: "Discordio", body: res?.error ? `Couldn't change status: ${res.error}` : done });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => setOpen(!open)}>
          <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, textAlign: "left" }}>
            <Dot color={current.color} />
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {current.label}
              <span style={{ opacity: 0.6 }}> · Change Status</span>
            </span>
            <span style={{ opacity: 0.5 }}>{open ? "▾" : "▸"}</span>
          </span>
        </ButtonItem>
      </PanelSectionRow>
      {open && (
        <>
          {STATUSES.map((s) => (
            <PanelSectionRow key={s.value}>
              <ButtonItem
                layout="below"
                disabled={busy}
                description={s.hint || undefined}
                onClick={() => set(s.value, null, `Status: ${s.label}`)}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Dot color={s.color} />
                  {s.label}
                  {s.value === current.value && <span style={{ marginLeft: "auto", color: "#23a55a" }}>✓</span>}
                </span>
              </ButtonItem>
            </PanelSectionRow>
          ))}
          <PanelSectionRow>
            <TextField label="Custom status" value={custom} onChange={(e) => setCustom(e.target.value)} />
          </PanelSectionRow>
          {/* The emoji in front of it: your current one, or a newly picked one. */}
          <PanelSectionRow>
            <div style={{ padding: "4px 2px" }}>
              <Focusable style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flex: "none" }}>
                  {shown?.url ? <img src={shown.url} style={{ width: 26, height: 26 }} /> : shown?.text ?? <span style={{ opacity: 0.4, fontSize: 12 }}>none</span>}
                </span>
                <DialogButton style={{ flex: 1, minWidth: 0, height: 40, minHeight: 40, padding: "0 6px", fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} onClick={() => setPicking(!picking)}>
                  {picking ? "Close Emojis" : "Choose Emoji"}
                </DialogButton>
                {shown && (
                  <DialogButton style={{ flex: 1, minWidth: 0, height: 40, minHeight: 40, padding: "0 6px", fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} onClick={() => { setEmoji("none"); setPicking(false); }}>
                    Remove
                  </DialogButton>
                )}
              </Focusable>
            </div>
          </PanelSectionRow>
          {picking && (
            <EmojiPicker
              channelId=""
              existing={[]}
              onPick={(e) => {
                setEmoji(e);
                setPicking(false);
              }}
              onClose={() => setPicking(false)}
            />
          )}
          <PanelSectionRow>
            <ChoiceSlider label="Clear After" choices={CLEAR_AFTER} value={clearAfter} onChange={setClearAfter} />
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={busy}
              onClick={() => set(null, custom, custom.trim() || shown ? "Custom status set" : "Custom status cleared")}
            >
              {custom.trim() || shown ? "Set Custom Status" : "Clear Custom Status"}
            </ButtonItem>
          </PanelSectionRow>
          {(status?.custom || status?.emoji) && (
            <PanelSectionRow>
              <ButtonItem
                layout="below"
                disabled={busy}
                onClick={async () => {
                  if (!confirmClear) return setConfirmClear(true);
                  setConfirmClear(false);
                  setEmoji("none");
                  setCustom("");
                  setBusy(true);
                  try {
                    const res: any = await call("set_status", null, "", "none", 0);
                    toaster.toast({ title: "Discordio", body: res?.error ? `Couldn't clear it: ${res.error}` : "Custom status cleared" });
                    if (!res?.error) {
                      setOpen(false);
                      setTimeout(() => fire("jump:top"), 60);
                    }
                  } finally {
                    setBusy(false);
                    setEmoji(undefined);
                  }
                }}
              >
                <span style={{ color: confirmClear ? "#fff" : "#ff6b6b" }}>
                  {confirmClear ? "Press Again to Clear" : "Clear Custom Status"}
                </span>
              </ButtonItem>
            </PanelSectionRow>
          )}
        </>
      )}
    </>
  );
}
