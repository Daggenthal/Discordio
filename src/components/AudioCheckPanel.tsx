import { addEventListener, call, removeEventListener } from "@decky/api";
import { ButtonItem, PanelSectionRow, ToggleField } from "@decky/ui";
import { useEffect, useRef, useState } from "react";

type MicResult = { peak?: number; average?: number; verdict?: string; audioState?: string; error?: string };
type SoundResult = { ok?: boolean; how?: string; error?: string; activated?: boolean; blocked?: number; last?: string };

const small = { fontSize: "12px", lineHeight: 1.35, wordBreak: "break-word" as const };

const VERDICT: Record<string, { color: string; text: string }> = {
  ok: { color: "#23a55a", text: "Your microphone works. Discord hears you clearly." },
  quiet: { color: "#f0b232", text: "Discord hears you, but quietly. Speak up, or raise the mic level in Steam's audio settings." },
  silent: {
    color: "#ed4245",
    text: "Discord hears silence. Check the microphone picked in Settings, and that it isn't muted in Steam.",
  },
};

// Check the microphone and speakers before joining a call: the test goes
// through exactly the path a call uses (Steam -> Discordio -> Discord).
export function AudioCheckPanel() {
  const [testing, setTesting] = useState(false);
  const [loopback, setLoopback] = useState(false);
  const [level, setLevel] = useState(0);
  const [mic, setMic] = useState<MicResult | null>(null);
  const [sound, setSound] = useState<SoundResult | null>(null);
  const [playing, setPlaying] = useState(false);
  const peak = useRef(0);

  useEffect(() => {
    const onLevel = (d: any) => {
      const v = Math.max(0, Math.min(1, Number(d?.level) || 0));
      peak.current = Math.max(peak.current, v);
      setLevel(v);
    };
    addEventListener("mic_level", onLevel);
    return () => removeEventListener("mic_level", onLevel);
  }, []);

  const testMic = async () => {
    setTesting(true);
    setMic(null);
    peak.current = 0;
    try {
      setMic(await call<[number, boolean], MicResult>("mic_test", 6, loopback));
    } catch (e) {
      setMic({ error: String(e) });
    } finally {
      setTesting(false);
      setLevel(0);
    }
  };

  const testSound = async () => {
    setPlaying(true);
    try {
      setSound(await call<[], SoundResult>("test_sound"));
    } catch (e) {
      setSound({ error: String(e) });
    } finally {
      setPlaying(false);
    }
  };

  const verdict = mic?.verdict ? VERDICT[mic.verdict] : null;

  return (
    <>
      <PanelSectionRow>
        <ToggleField
          label="Hear yourself"
          description="Plays your microphone back through your speakers or headset during the test"
          checked={loopback}
          onChange={setLoopback}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={testing} onClick={testMic}>
          {testing ? "Testing... say something" : "Test microphone (6s)"}
        </ButtonItem>
      </PanelSectionRow>
      {(testing || mic) && (
        <PanelSectionRow>
          <div style={{ width: "100%" }}>
            <div style={{ height: 10, borderRadius: 5, background: "rgba(255,255,255,0.12)", overflow: "hidden" }}>
              <div
                style={{
                  width: `${Math.round((testing ? level : mic?.peak ?? 0) * 100)}%`,
                  height: "100%",
                  background: level > 0.6 ? "#f0b232" : "#23a55a",
                  transition: "width 90ms linear",
                }}
              />
            </div>
            {mic?.error && <div style={{ ...small, color: "#ed4245", marginTop: 6 }}>Test failed: {mic.error}</div>}
            {verdict && <div style={{ ...small, color: verdict.color, marginTop: 6 }}>{verdict.text}</div>}
            {mic && !mic.error && mic.audioState && mic.audioState !== "running" && (
              <div style={{ ...small, color: "#f0b232", marginTop: 4 }}>
                Discord's audio engine is {mic.audioState}: calls may be silent. Try Restart Discord in Diagnostics.
              </div>
            )}
          </div>
        </PanelSectionRow>
      )}
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={playing} onClick={testSound}>
          {playing ? "Playing..." : "Play a test sound"}
        </ButtonItem>
      </PanelSectionRow>
      {sound && (
        <PanelSectionRow>
          <div style={{ ...small, color: sound.error ? "#ed4245" : undefined }}>
            {sound.error
              ? `No sound: ${sound.error}`
              : `Played ${sound.how}. If you heard nothing, pick another speaker or headset in Settings.`}
            {!sound.error && sound.activated === false && " (Sound is still blocked in the Discord view.)"}
          </div>
        </PanelSectionRow>
      )}
    </>
  );
}
