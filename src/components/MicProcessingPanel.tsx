import { call, toaster } from "@decky/api";
import { PanelSectionRow, SliderField, ToggleField } from "@decky/ui";
import { useEffect, useRef, useState } from "react";
import { getProcessing, Processing, setProcessing } from "../lib/audio";

type Mode = { mode?: string; autoThreshold: boolean; threshold: number; error?: string };

// Voice processing (applied where Steam opens the mic) and Discord's
// input sensitivity, so background noise doesn't keep you "talking".
export function MicProcessingPanel() {
  const [proc, setProc] = useState<Processing>(getProcessing());
  const [mode, setMode] = useState<Mode | null>(null);
  const pending = useRef<any>(null);

  useEffect(() => {
    call<[], Mode>("get_voice_mode")
      .then((m) => setMode(m && !m.error ? m : null))
      .catch(() => {});
  }, []);

  const toggle = async (key: keyof Processing, v: boolean) => {
    setProc({ ...proc, [key]: v });
    try {
      await setProcessing({ [key]: v });
    } catch (e) {
      toaster.toast({ title: "Discordio", body: `Couldn't change the microphone: ${e}` });
    }
  };

  const sens = (auto: boolean, threshold?: number) => {
    if (!mode) return;
    setMode({ ...mode, autoThreshold: auto, threshold: threshold ?? mode.threshold });
    clearTimeout(pending.current);
    pending.current = setTimeout(() => call("set_sensitivity", auto, threshold ?? mode.threshold).catch(() => {}), 300);
  };

  return (
    <>
      <PanelSectionRow>
        <div style={{ fontWeight: 700, fontSize: "13px", marginTop: "6px" }}>Voice Processing</div>
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleField
          label="Noise Suppression"
          description="Filters out fans, keyboards and background hum"
          checked={proc.noiseSuppression}
          onChange={(v) => toggle("noiseSuppression", v)}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleField
          label="Echo Cancellation"
          description="Stops others hearing themselves when you use speakers instead of a headset"
          checked={proc.echoCancellation}
          onChange={(v) => toggle("echoCancellation", v)}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleField
          label="Automatic Gain"
          description="Evens out your volume when you move closer or further away"
          checked={proc.autoGainControl}
          onChange={(v) => toggle("autoGainControl", v)}
        />
      </PanelSectionRow>
      {mode && mode.mode !== "PUSH_TO_TALK" && (
        <>
          <PanelSectionRow>
            <ToggleField
              label="Automatic Sensitivity"
              description="Let Discord decide when you're talking"
              checked={mode.autoThreshold}
              onChange={(v) => sens(v)}
            />
          </PanelSectionRow>
          {!mode.autoThreshold && (
            <PanelSectionRow>
              {/* 1-based: Steam's slider ignores input at 0. Position p = p - 100 dB. */}
              <SliderField
                label="Mic Sensitivity"
                description={`Sounds quieter than ${Math.round(mode.threshold)} dB don't count as talking. Lower picks up more.`}
                min={1}
                max={100}
                step={1}
                value={Math.max(1, Math.min(100, Math.round(mode.threshold) + 100))}
                onChange={(p) => sens(false, p - 100)}
              />
            </PanelSectionRow>
          )}
        </>
      )}
    </>
  );
}
