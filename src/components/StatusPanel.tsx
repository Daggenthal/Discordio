import { call, toaster } from "@decky/api";
import { ButtonItem, PanelSectionRow, TextField } from "@decky/ui";
import { useEffect, useState } from "react";

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
export function StatusPanel({ status }: { status?: { status: string; custom: string | null } | null }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(status?.custom ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) setCustom(status?.custom ?? "");
  }, [status?.custom, open]);

  const current = STATUSES.find((s) => s.value === status?.status) ?? STATUSES[0];
  const set = async (st: string | null, text: string | null, done: string) => {
    setBusy(true);
    try {
      const res: any = await call("set_status", st, text);
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
          <PanelSectionRow>
            <ButtonItem layout="below" disabled={busy} onClick={() => set(null, custom, custom.trim() ? "Custom status set" : "Custom status cleared")}>
              {custom.trim() ? "Set Custom Status" : "Clear Custom Status"}
            </ButtonItem>
          </PanelSectionRow>
        </>
      )}
    </>
  );
}
