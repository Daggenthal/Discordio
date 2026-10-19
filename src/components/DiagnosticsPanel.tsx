import { ButtonItem, PanelSection, PanelSectionRow } from "@decky/ui";
import { ChoiceSlider } from "./ChoiceSlider";
import { call } from "@decky/api";
import { useEffect, useState } from "react";
import { getDiag, subscribeDiag, DiagEntry } from "../lib/diag";
import { BoundsMode, getBoundsMode, setBoundsMode } from "../lib/view";

const BOUNDS_OPTIONS: { value: BoundsMode; short: string; label: string }[] = [
  { value: "auto", short: "Auto", label: "Auto (window size)" },
  { value: "device", short: "Device", label: "Device pixels" },
  { value: "legacy", short: "Deck", label: "Legacy (Steam Deck)" },
];

export function DiagnosticsPanel({ backend }: { backend: any }) {
  const [entries, setEntries] = useState<DiagEntry[]>(getDiag());
  const [bounds, setBounds] = useState<BoundsMode>(getBoundsMode());
  const [open, setOpen] = useState(false);

  useEffect(() => subscribeDiag(() => setEntries(getDiag())), []);

  const failed = entries.filter((e) => !e.ok).length + (backend?.error ? 1 : 0);

  return (
    <PanelSection title="Diagnostics">
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => setOpen(!open)}>
          {open ? "Hide details" : failed ? `Show details (${failed} problem${failed > 1 ? "s" : ""})` : "Show details"}
        </ButtonItem>
      </PanelSectionRow>
      {open && (
        <>
          <PanelSectionRow>
            <div style={{ fontSize: "12px", lineHeight: "16px", wordBreak: "break-word" }}>
              <div>
                <b>Backend:</b> {backend?.stage ?? "no response"}
                {backend?.attempts ? ` (attempt ${backend.attempts})` : ""}
              </div>
              {backend?.error && (
                <div style={{ color: "#ff6b6b" }}>{backend.error}</div>
              )}
              {entries.map((e) => (
                <div key={e.step} style={{ color: e.ok ? undefined : "#ff6b6b" }}>
                  {e.ok ? "OK" : "FAIL"} {e.step}
                  {e.detail ? `: ${e.detail}` : ""}
                </div>
              ))}
            </div>
          </PanelSectionRow>
          <PanelSectionRow>
            <ChoiceSlider
              label="Discord view sizing"
              description="Try another option if Discord shows a blank or gray screen"
              choices={BOUNDS_OPTIONS}
              value={bounds}
              onChange={(v) => {
                setBounds(v);
                setBoundsMode(v);
              }}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => call("restart_discord")}>
              Restart Discord tab
            </ButtonItem>
          </PanelSectionRow>
        </>
      )}
    </PanelSection>
  );
}
