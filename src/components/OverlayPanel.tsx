import { call } from "@decky/api";
import { DropdownItem, PanelSectionRow, ToggleField } from "@decky/ui";
import { useEffect, useState } from "react";

type OverlaySettings = { enabled: boolean; position: string; status: string };

const POSITIONS = [
  { data: "top-left", label: "Top left" },
  { data: "top-right", label: "Top right" },
  { data: "bottom-left", label: "Bottom left" },
  { data: "bottom-right", label: "Bottom right" },
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
          <DropdownItem
            label="Position"
            rgOptions={POSITIONS}
            selectedOption={s.position}
            onChange={(o) => update(undefined, o.data)}
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
