import { call } from "@decky/api";
import { PanelSectionRow, ToggleField } from "@decky/ui";
import { ChoiceSlider } from "./ChoiceSlider";
import { useEffect, useState } from "react";

type OverlaySettings = { enabled: boolean; position: string; engine: string; active: string | null; status: string; perf_overlay?: string; calls?: boolean;
  size?: string; opacity?: number; speakers_only?: boolean };

const SIZES = [
  { value: "small", short: "Small", label: "Small" },
  { value: "normal", short: "Normal", label: "Normal" },
  { value: "large", short: "Large", label: "Large" },
];
const OPACITIES = [40, 50, 60, 70, 80, 90, 100].map((v) => ({ value: v, short: v === 40 || v === 70 || v === 100 ? `${v}%` : "", label: `${v}%` }));

const ENGINES = [
  { value: "auto", short: "Auto", label: "Auto" },
  { value: "gamescope", short: "Gamescope", label: "Gamescope overlay" },
  { value: "steam", short: "Steam", label: "Steam overlay layer" },
];

const ENGINE_HELP: Record<string, string> = {
  auto: "Uses the gamescope overlay, and switches to Steam's overlay layer while the performance overlay (FPS) is on, so both show at once",
  gamescope: "Smoothest. While Steam's performance overlay is on, Steam's overlay layer is used instead (gamescope shows only one)",
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

  const update = async (enabled?: boolean, position?: string, engine?: string, calls?: boolean) => {
    const res = await call<[boolean | null, string | null, string | null, boolean | null], OverlaySettings>(
      "set_overlay_settings",
      enabled ?? null,
      position ?? null,
      engine ?? null,
      calls ?? null
    );
    setS(res);
  };

  const look = async (size?: string, opacity?: number, speakersOnly?: boolean) => {
    const res = await call<[string | null, number | null, boolean | null], OverlaySettings>(
      "set_overlay_look",
      size ?? null,
      opacity ?? null,
      speakersOnly ?? null
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
      {!s.enabled && (
        <PanelSectionRow>
          <ToggleField
            label="Turn on for calls"
            description="Show the overlay while a call is ringing or you're in one, even with it off"
            checked={s.calls !== false}
            onChange={(v) => update(undefined, undefined, undefined, v)}
          />
        </PanelSectionRow>
      )}
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
      {(s.enabled || s.calls !== false) && (
        <>
          <PanelSectionRow>
            <ChoiceSlider label="Size" choices={SIZES} value={s.size ?? "normal"} onChange={(v) => look(v)} />
          </PanelSectionRow>
          <PanelSectionRow>
            <ChoiceSlider
              label="Opacity"
              choices={OPACITIES}
              value={Math.round((s.opacity ?? 100) / 10) * 10}
              onChange={(v) => look(undefined, v)}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <ToggleField
              label="Only show who's talking"
              description="The voice panel lists only people speaking, and hides when nobody is"
              checked={!!s.speakers_only}
              onChange={(v) => look(undefined, undefined, v)}
            />
          </PanelSectionRow>
        </>
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
