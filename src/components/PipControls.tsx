import { addEventListener, call, removeEventListener } from "@decky/api";
import { ButtonItem, PanelSectionRow, SliderField } from "@decky/ui";
import { useEffect, useState } from "react";
import { on } from "../lib/events";
import { stopWatching } from "../lib/watch";
import { ChoiceSlider } from "./ChoiceSlider";

type Pip = { on: boolean; name?: string | null; frames?: number; live?: boolean; volume?: number; kind?: string };

const POSITIONS = [
  { value: "top-left", short: "TL", label: "Top left" },
  { value: "top-right", short: "TR", label: "Top right" },
  { value: "bottom-left", short: "BL", label: "Bottom left" },
  { value: "bottom-right", short: "BR", label: "Bottom right" },
];
export const PIP_FPS = [10, 30, 40, 60].map((v) => ({ value: v, short: `${v}`, label: `${v} fps` }));

// While a stream is showing in the overlay: where, how big, and stop.
export function PipControls() {
  const [pip, setPip] = useState<Pip>({ on: false });
  // What you just set, until the next poll confirms it.
  const [volOverride, setVolOverride] = useState<number | null>(null);
  const setVol = (v: number) => {
    setVolOverride(v);
    setTimeout(() => setVolOverride(null), 3000);
  };
  const [look, setLook] = useState<{ position: string; size: number | string; fps: number } | null>(null);
  useEffect(() => {
    const load = () => call<[], Pip>("get_pip").then(setPip).catch(() => {});
    load();
    const t = setInterval(load, 2000);
    const off = on("pip-changed", load);
    const onEvt = () => load();
    addEventListener("pip", onEvt);
    call<[], any>("set_pip_look").then(setLook).catch(() => {});
    return () => {
      clearInterval(t);
      off();
      removeEventListener("pip", onEvt);
    };
  }, []);
  if (!pip.on) return null;
  const vol = volOverride ?? pip.volume ?? 100;
  const set = async (position?: string, size?: string, fps?: number) =>
    setLook(await call<any[], any>("set_pip_look", position ?? null, size ?? null, fps ?? null));
  return (
    <>
      <PanelSectionRow>
        <div style={{ fontSize: 12, opacity: 0.8 }}>
          {pip.kind === "camera"
            ? `📷 Showing ${pip.name || "someone"}'s camera in the overlay`
            : `📺 Watching ${pip.name || "a stream"} in the overlay`}
          {pip.live ? "" : " (waiting for video...)"}
        </div>
      </PanelSectionRow>
      {look && (
        <>
          <PanelSectionRow>
            <ChoiceSlider label="Stream Position" choices={POSITIONS} value={look.position} onChange={(v) => set(v)} />
          </PanelSectionRow>
          <PanelSectionRow>
            {/* 10 % steps; 1-based (Steam's slider ignores input at 0). */}
            <SliderField
              label={`Stream Size: ${Number(look.size) || 100}%`}
              description="100% is the normal size"
              min={1}
              max={30}
              step={1}
              value={Math.max(1, Math.min(30, Math.round((Number(look.size) || 100) / 10)))}
              onChange={(v) => set(undefined, String(v * 10) as any)}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <ChoiceSlider label="Stream Frame Rate" description="Higher is smoother but uses more CPU" choices={PIP_FPS} value={look.fps ?? 30} onChange={(v) => set(undefined, undefined, v)} />
          </PanelSectionRow>
        </>
      )}
      {pip.kind !== "camera" && (
        <>
      <PanelSectionRow>
        {/* 0-200 % in 10 % steps; 1-based (Steam's slider ignores input at 0). */}
        <SliderField
          label={`Stream Volume: ${vol}%`}
          description="Only for you, like Discord's stream volume"
          min={1}
          max={21}
          step={1}
          value={Math.round(vol / 10) + 1}
          onChange={(p) => {
            const v = (p - 1) * 10;
            setVol(v);
            call("set_stream_volume", v).catch(() => {});
          }}
        />
      </PanelSectionRow>
        </>
      )}
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={stopWatching}>
          Stop Watching
        </ButtonItem>
      </PanelSectionRow>
    </>
  );
}
