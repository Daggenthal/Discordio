import { ButtonItem, PanelSectionRow, Router } from "@decky/ui";
import { ChoiceSlider } from "./ChoiceSlider";
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

const RESOLUTIONS: { data: string; label: string; short: string; height: number | null }[] = [
  { data: "480", label: "480p", short: "480", height: 480 },
  { data: "720", label: "720p", short: "720", height: 720 },
  { data: "1080", label: "1080p", short: "1080", height: 1080 },
  { data: "1440", label: "1440p", short: "1440", height: 1440 },
  { data: "2160", label: "4K (2160p)", short: "4K", height: 2160 },
  { data: "source", label: "Source", short: "Src", height: null },
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
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);

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
    setStatus({ text: live ? "Stopping stream..." : "Starting stream... (can take up to 20 seconds)" });
    try {
      const res: any = await call(live ? "stop_go_live" : "go_live");
      if (res && res.ok === false) {
        const msg = res.error || "Could not start the stream";
        setStatus({ text: msg, error: true });
        toaster.toast({ title: "Discordio", body: msg });
      } else if (res?.method === "ui" && !live) {
        setStatus({ text: "Opened Discord's own share button; finish there" });
        // Discord's own button was used; it may want a confirmation, so show it.
        Router.Navigate("/discord");
      } else {
        setStatus({ text: live ? "Stream stopped" : `Live (started via ${res?.method ?? "Discord"})` });
      }
    } catch (e) {
      setStatus({ text: String(e), error: true });
    } finally {
      setBusy(false);
    }
  };

  const selected = RESOLUTIONS.find((r) => r.data === settings.resolution) ?? RESOLUTIONS[1];
  const needsUpgrade = overRes(selected.height, limits) || overFps(settings.fps, limits);

  return (
    <>
      <PanelSectionRow>
        <ChoiceSlider
          label="Resolution"
          choices={RESOLUTIONS.map((r) => ({
            value: r.data,
            short: r.short,
            label: overRes(r.height, limits) ? `${r.label} (needs Nitro)` : r.label,
          }))}
          value={settings.resolution}
          onChange={(v) => save(v, undefined)}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ChoiceSlider
          label="Frame rate"
          choices={FRAME_RATES.map((f) => ({
            value: f,
            short: String(f),
            label: overFps(f, limits) ? `${f} fps (needs Nitro)` : `${f} fps`,
          }))}
          value={settings.fps}
          onChange={(v) => save(undefined, v)}
        />
      </PanelSectionRow>
      {inVoice && <StreamPreview />}
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
            {busy ? (live ? "Stopping..." : "Starting...") : live ? "Stop streaming" : "Go Live"}
          </span>
        </ButtonItem>
      </PanelSectionRow>
      {status && (
        <PanelSectionRow>
          <div style={{ fontSize: "12px", color: status.error ? "#ff6b6b" : undefined, opacity: status.error ? 1 : 0.8, wordBreak: "break-word" }}>
            {status.text}
          </div>
        </PanelSectionRow>
      )}
    </>
  );
}

// A snapshot of exactly what Go Live will send, taken from the same capture
// source the stream uses. Refreshes every few seconds while visible.
export function StreamPreview() {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const timeout = new Promise<{ error: string }>((r) =>
      setTimeout(() => r({ error: "the capture helper didn't answer within 12s" }), 12000)
    );
    Promise.race([call<[], { image?: string; error?: string; pending?: string }>("get_stream_preview"), timeout])
      .then((res: { image?: string; error?: string; pending?: string }) => {
        if (!alive) return;
        if (res?.image) {
          setUrl(res.image);
          setError(null);
          setPending(null);
        } else if (res?.pending) {
          setPending(res.pending);
          setError(null);
        } else {
          setError(res?.error || "no image");
          setPending(null);
        }
      })
      .catch((e) => alive && setError(String(e)));
    const t = setTimeout(() => alive && setTick((n) => n + 1), 4000);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [tick]);

  return (
    <PanelSectionRow>
      <div style={{ width: "100%" }}>
        <div style={{ fontSize: "12px", opacity: 0.75, marginBottom: "4px" }}>Stream preview (what viewers will see)</div>
        {url && !error && !pending ? (
          <img src={url} style={{ width: "100%", borderRadius: "6px", display: "block", background: "#000" }} />
        ) : (
          <div
            style={{
              width: "100%", aspectRatio: "16 / 9", borderRadius: "6px", background: "#0e0f11",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: "11px", padding: "8px", boxSizing: "border-box", textAlign: "center",
              color: error ? "#ff6b6b" : "#9aa0a6", wordBreak: "break-word",
            }}
          >
            {error ? `No preview: ${error}` : pending ?? "Loading preview..."}
          </div>
        )}
      </div>
    </PanelSectionRow>
  );
}
