import { ButtonItem, PanelSection, PanelSectionRow } from "@decky/ui";
import { addEventListener, call, removeEventListener, toaster } from "@decky/api";
import { useEffect, useState } from "react";
import { ChoiceSlider } from "./ChoiceSlider";
import { getSliderLog, getDiag, subscribeDiag, DiagEntry } from "../lib/diag";
import { BoundsMode, getBoundsMode, setBoundsMode } from "../lib/view";
import { micStatus } from "../lib/mic";

type Component = { key: string; label: string; state: string; detail: string; since: number };
type Diagnostics = {
  version: string;
  components: Component[];
  errors: { time: number; component: string; message: string }[];
  bridge: any;
  capture: { running: boolean; port: number; status: any; last_exit: number | null };
};
type TestResult = { name: string; ok: boolean; detail: string; ms: number };

const COLORS: Record<string, string> = {
  ok: "#23a55a",
  warn: "#f0b232",
  error: "#ed4245",
  pending: "#8e9297",
  off: "#5c5f66",
};

const BOUNDS_OPTIONS: { value: BoundsMode; short: string; label: string }[] = [
  { value: "auto", short: "Auto", label: "Auto (window size)" },
  { value: "device", short: "Device", label: "Device pixels" },
  { value: "legacy", short: "Deck", label: "Legacy (Steam Deck)" },
];

const small = { fontSize: "11px", lineHeight: "15px", wordBreak: "break-word" as const };
const time = (t: number) => new Date(t * 1000).toLocaleTimeString();

const Dot = ({ state }: { state: string }) => (
  <span
    style={{
      display: "inline-block", width: 9, height: 9, borderRadius: "50%", flexShrink: 0, marginTop: 3,
      background: COLORS[state] ?? COLORS.pending,
    }}
  />
);

// Everything that can go wrong, in one place: live health of each part,
// recent errors, a step-by-step self-test, fix-it buttons, and a report file.
export function DiagnosticsPanel() {
  const [d, setD] = useState<Diagnostics | null>(null);
  const [open, setOpen] = useState(false);
  const [tests, setTests] = useState<TestResult[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [qam, setQam] = useState<DiagEntry[]>(getDiag());
  const [bounds, setBounds] = useState<BoundsMode>(getBoundsMode());

  const load = () => call<[], Diagnostics>("get_diagnostics").then(setD).catch(() => {});

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    const onDiag = () => load();
    addEventListener("diag", onDiag);
    const unsub = subscribeDiag(() => setQam(getDiag()));
    return () => {
      clearInterval(t);
      removeEventListener("diag", onDiag);
      unsub();
    };
  }, []);

  const problems = (d?.components ?? []).filter((c) => c.state === "error" || c.state === "warn");
  const qamProblems = qam.filter((e) => !e.ok);
  const summary = !d
    ? "Checking..."
    : problems.length + qamProblems.length === 0
    ? "Everything looks good"
    : `${problems.length + qamProblems.length} problem${problems.length + qamProblems.length > 1 ? "s" : ""}: ${
        (problems[0]?.label ?? qamProblems[0]?.step) || ""
      }`;

  const selfTest = async () => {
    setTesting(true);
    setTests(null);
    try {
      setTests(await call<[], TestResult[]>("run_self_test"));
    } catch (e) {
      setTests([{ name: "Self-test", ok: false, detail: String(e), ms: 0 }]);
    } finally {
      setTesting(false);
      load();
    }
  };

  const exportReport = async () => {
    try {
      const path = await call<[any], string>("export_report", {
        checks: getDiag(),
        mic: micStatus(),
        sliders: getSliderLog().map((e) => `${new Date(e.t).toLocaleTimeString()} ${e.slider}: ${e.what}`),
      });
      toaster.toast({ title: "Discordio report saved", body: path });
    } catch (e) {
      toaster.toast({ title: "Discordio", body: `Couldn't write the report: ${e}` });
    }
  };

  return (
    <PanelSection title="Diagnostics">
      <PanelSectionRow>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: "13px" }}>
          <Dot state={!d ? "pending" : problems.some((p) => p.state === "error") ? "error" : problems.length || qamProblems.length ? "warn" : "ok"} />
          <span>{summary}</span>
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => setOpen(!open)}>
          {open ? "Hide diagnostics" : "Show diagnostics"}
        </ButtonItem>
      </PanelSectionRow>

      {open && (
        <>
          {d?.components.map((c) => (
            <PanelSectionRow key={c.key}>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start", ...small }}>
                <Dot state={c.state} />
                <div>
                  <b>{c.label}</b>
                  <div style={{ opacity: 0.85 }}>{c.detail}</div>
                </div>
              </div>
            </PanelSectionRow>
          ))}

          {getSliderLog().length > 0 && (
            <PanelSectionRow>
              <div style={small}>
                <b>Slider log</b> (newest last)
                {getSliderLog()
                  .slice(-16)
                  .map((e, i) => (
                    <div key={i} style={{ opacity: 0.85 }}>
                      {new Date(e.t).toLocaleTimeString()} {e.slider}: {e.what}
                    </div>
                  ))}
              </div>
            </PanelSectionRow>
          )}
          {qamProblems.length > 0 && (
            <PanelSectionRow>
              <div style={small}>
                <b>QAM side</b>
                {qamProblems.map((e) => (
                  <div key={e.step} style={{ color: COLORS.error }}>
                    {e.step}
                    {e.detail ? `: ${e.detail}` : ""}
                  </div>
                ))}
              </div>
            </PanelSectionRow>
          )}

          <PanelSectionRow>
            <ButtonItem layout="below" disabled={testing} onClick={selfTest} description="Checks each part in order and stops at what's broken">
              {testing ? "Testing... (up to 30s)" : "Run self-test"}
            </ButtonItem>
          </PanelSectionRow>
          {tests && (
            <PanelSectionRow>
              <div style={small}>
                {tests.map((t) => (
                  <div key={t.name} style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 3 }}>
                    <Dot state={t.ok ? "ok" : "error"} />
                    <div>
                      <b>{t.name}</b> <span style={{ opacity: 0.6 }}>{t.ms} ms</span>
                      <div style={{ color: t.ok ? undefined : COLORS.error }}>{t.detail}</div>
                    </div>
                  </div>
                ))}
              </div>
            </PanelSectionRow>
          )}

          {d && d.errors.length > 0 && (
            <PanelSectionRow>
              <div style={small}>
                <b>Recent errors</b>
                {d.errors.slice(0, 8).map((e, i) => (
                  <div key={i}>
                    <span style={{ opacity: 0.6 }}>{time(e.time)}</span> {e.component}: {e.message}
                  </div>
                ))}
              </div>
            </PanelSectionRow>
          )}

          <PanelSectionRow>
            <ButtonItem layout="below" onClick={exportReport} description="Writes discordio-report.txt to your home folder, to share when asking for help">
              Export report
            </ButtonItem>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => call("restart_discord")}>
              Restart Discord view
            </ButtonItem>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => call("restart_capture")}>
              Restart screen capture
            </ButtonItem>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              onClick={() => call("reset_capture_method")}
              description="Forget the saved capture method and search again on the next preview"
            >
              Re-detect capture method
            </ButtonItem>
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
          <CaptureLog />
          {d && (
            <PanelSectionRow>
              <div style={{ ...small, opacity: 0.6 }}>
                Discordio {d.version} · bridge {d.bridge?.connected ? `connected, ${d.bridge.latency_ms} ms` : "offline"} ·{" "}
                {d.bridge?.requests ?? 0} requests, {d.bridge?.failed ?? 0} failed, {d.bridge?.timeouts ?? 0} timeouts
              </div>
            </PanelSectionRow>
          )}
        </>
      )}
    </PanelSection>
  );
}

// Last lines from the screen-capture helper.
function CaptureLog() {
  const [log, setLog] = useState<{ running: boolean; lines: string[] } | null>(null);
  useEffect(() => {
    const load = () => call<[], { running: boolean; lines: string[] }>("get_capture_log").then(setLog).catch(() => {});
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, []);
  if (!log) return null;
  return (
    <PanelSectionRow>
      <div style={{ ...small, fontFamily: "monospace" }}>
        <div style={{ fontFamily: "inherit", fontWeight: 700, color: log.running ? undefined : COLORS.error }}>
          Capture helper: {log.running ? "running" : "not running"}
        </div>
        {log.lines.length === 0 ? <div style={{ opacity: 0.6 }}>(no output yet)</div> : log.lines.map((l, i) => <div key={i}>{l}</div>)}
      </div>
    </PanelSectionRow>
  );
}
