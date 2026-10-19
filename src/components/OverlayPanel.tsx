import { call } from "@decky/api";
import { PanelSectionRow, ToggleField } from "@decky/ui";
import { ChoiceSlider } from "./ChoiceSlider";
import { useEffect, useState } from "react";

type OverlaySettings = { enabled: boolean; position: string; status: string };

const POSITIONS = [
  { value: "top-left", short: "TL", label: "Top left" },
  { value: "top-right", short: "TR", label: "Top right" },
  { value: "bottom-left", short: "BL", label: "Bottom left" },
  { value: "bottom-right", short: "BR", label: "Bottom right" },
];

export function OverlayPanel() {
  const [s, setS] = useState<OverlaySettings | null>(null);

  useEffect(() => {
    const load = () => call<[], OverlaySettings>("get_overlay_settings").then(setS).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  const update = async (enabled?: boolean, position?: string) => {
    const res = await call<[boolean | null, string | null], OverlaySettings>(
      "set_overlay_settings",
      enabled ?? null,
      position ?? null
    );
    setS(res);
  };

  if (!s) return null;

  return (
    <>
      <PanelSectionRow>
        <ToggleField
          label="In-game overlay"
          description="Shows your voice channel on top of games: who's talking, muted, deafened or live"
          checked={s.enabled}
          onChange={(v) => update(v)}
        />
      </PanelSectionRow>
      {s.enabled && (
        <PanelSectionRow>
          <ChoiceSlider
            label="Position"
            choices={POSITIONS}
            value={s.position}
            onChange={(v) => update(undefined, v)}
          />
        </PanelSectionRow>
      )}
      {s.enabled && s.status && !s.status.startsWith("running") && (
        <PanelSectionRow>
          <div style={{ fontSize: "11px", color: "#ff6b6b", wordBreak: "break-word" }}>Overlay {s.status}</div>
        </PanelSectionRow>
      )}
    </>
  );
}
