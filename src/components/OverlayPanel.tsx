import { call } from "@decky/api";
import { PanelSectionRow, ToggleField } from "@decky/ui";
import { ChoiceSlider } from "./ChoiceSlider";
import { useEffect, useState } from "react";

type OverlaySettings = { enabled: boolean; position: string; engine: string; active: string | null; status: string; perf_overlay?: string };

const ENGINES = [
  { value: "auto", short: "Auto", label: "Auto" },
  { value: "gamescope", short: "Gamescope", label: "Gamescope overlay" },
  { value: "steam", short: "Steam", label: "Steam overlay layer" },
];

const ENGINE_HELP: Record<string, string> = {
  auto: "Uses the gamescope overlay, and switches to Steam's overlay layer while the performance overlay (FPS) is on, so both show at once",
  gamescope: "Smoothest, but hides while Steam's performance overlay is on (gamescope allows only one)",
  steam: "Drawn inside Steam's own overlay, works alongside the performance overlay",
};

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

  const update = async (enabled?: boolean, position?: string, engine?: string) => {
    const res = await call<[boolean | null, string | null, string | null], OverlaySettings>(
      "set_overlay_settings",
      enabled ?? null,
      position ?? null,
      engine ?? null
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
      {s.enabled && (
        <PanelSectionRow>
          <ChoiceSlider
            label="Engine"
            description={ENGINE_HELP[s.engine] ?? ""}
            choices={ENGINES}
            value={s.engine}
            onChange={(v) => update(undefined, undefined, v)}
          />
        </PanelSectionRow>
      )}
      {s.enabled && s.engine === "auto" && (
        <PanelSectionRow>
          <div style={{ fontSize: "11px", opacity: 0.7 }}>
            Using {s.active === "steam" ? "Steam's overlay layer" : "the gamescope overlay"} (performance overlay:{" "}
            {s.perf_overlay || "unknown"})
          </div>
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
