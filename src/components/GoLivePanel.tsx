import { ButtonItem, DropdownItem, PanelSectionRow, Router } from "@decky/ui";
import { call, toaster } from "@decky/api";
import { useEffect, useState } from "react";
import { FaVideo, FaStop } from "react-icons/fa";
import { useDeckcordState } from "../hooks/useDeckcordState";

type StreamSettings = { resolution: string; fps: number };
type Limits = {
  plan: string;
  max_height: number | null; // null = source / no cap
  max_fps: number;
  reason: string;
  boost_level: number;
  error?: string;
};

const RESOLUTIONS: { data: string; label: string; height: number | null }[] = [
  { data: "480", label: "480p", height: 480 },
  { data: "720", label: "720p", height: 720 },
  { data: "1080", label: "1080p", height: 1080 },
  { data: "1440", label: "1440p", height: 1440 },
  { data: "2160", label: "4K (2160p)", height: 2160 },
  { data: "source", label: "Source", height: null },
];

const FRAME_RATES = [5, 10, 15, 24, 30, 45, 60];

const overRes = (h: number | null, lim: Limits | null) =>
  !!lim && !lim.error && lim.max_height !== null && (h === null || h > lim.max_height);
const overFps = (fps: number, lim: Limits | null) => !!lim && !lim.error && fps > lim.max_fps;

const describe = (lim: Limits) => {
  const res = lim.max_height === null ? "source resolution" : `${lim.max_height}p`;
  return `${res} at ${lim.max_fps} fps`;
};

export function GoLivePanel({ inCall }: { inCall?: boolean } = {}) {
  const state = useDeckcordState();
  const [settings, setSettings] = useState<StreamSettings>({ resolution: "720", fps: 30 });
  const [limits, setLimits] = useState<Limits | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call<[], StreamSettings>("get_stream_settings").then((s) => s && setSettings(s)).catch(() => {});
    call<[], Limits>("get_stream_limits").then(setLimits).catch(() => {});
  }, [inCall]);

  const inVoice = inCall ?? (state?.vc && Object.keys(state.vc).length > 0);
  const live = !!state?.me?.is_live;

  const save = async (resolution?: string, fps?: number) => {
    const s = await call<[string | null, number | null], StreamSettings>(
      "set_stream_settings",
      resolution ?? null,
      fps ?? null
    );
    if (s) setSettings(s);
  };

  const toggle = async () => {
    setBusy(true);
    try {
      const res: any = await call(live ? "stop_go_live" : "go_live");
      if (res && res.ok === false) {
        toaster.toast({ title: "Discordio", body: res.error || "Could not start the stream" });
      } else if (res?.method === "ui" && !live) {
        // Discord's own button was used; it may want a confirmation, so show it.
        Router.Navigate("/discord");
      }
    } finally {
      setBusy(false);
    }
  };

  const selected = RESOLUTIONS.find((r) => r.data === settings.resolution) ?? RESOLUTIONS[1];
  const needsUpgrade = overRes(selected.height, limits) || overFps(settings.fps, limits);

  return (
    <>
      <PanelSectionRow>
        <DropdownItem
          label="Resolution"
          rgOptions={RESOLUTIONS.map((r) => ({
            data: r.data,
            label: overRes(r.height, limits) ? `${r.label} (Nitro)` : r.label,
          }))}
          selectedOption={settings.resolution}
          onChange={(o) => save(o.data, undefined)}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <DropdownItem
          label="Frame rate"
          rgOptions={FRAME_RATES.map((f) => ({
            data: f,
            label: overFps(f, limits) ? `${f} fps (Nitro)` : `${f} fps`,
          }))}
          selectedOption={settings.fps}
          onChange={(o) => save(undefined, o.data)}
        />
      </PanelSectionRow>
      {limits && !limits.error && (
        <PanelSectionRow>
          <div style={{ fontSize: "12px", lineHeight: "16px", color: needsUpgrade ? "#f0b232" : undefined, opacity: needsUpgrade ? 1 : 0.75 }}>
            {limits.reason}: you can stream up to {describe(limits)}.
            {needsUpgrade &&
              " Discord will lower your stream to that. Higher settings need Nitro, or a server boosted to level 2."}
          </div>
        </PanelSectionRow>
      )}
      <PanelSectionRow>
        <ButtonItem
          layout="below"
          disabled={!inVoice || busy}
          onClick={toggle}
          description={inVoice ? "Changes apply the next time you go live" : "Join a voice channel or call first"}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
            {live ? <FaStop /> : <FaVideo />}
            {live ? "Stop streaming" : "Go Live"}
          </span>
        </ButtonItem>
      </PanelSectionRow>
    </>
  );
}
