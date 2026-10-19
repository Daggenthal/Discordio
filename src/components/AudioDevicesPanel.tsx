import { call, toaster } from "@decky/api";
import { ButtonItem, PanelSectionRow } from "@decky/ui";
import { useEffect, useState } from "react";
import { Device, getMicId, listMics, setMic } from "../lib/audio";

type Outputs = { outputs: { id: string; name: string }[]; output: string | null; error?: string };

const Heading = ({ children }: { children: any }) => (
  <PanelSectionRow>
    <div style={{ fontWeight: 700, fontSize: "13px", marginTop: "6px" }}>{children}</div>
  </PanelSectionRow>
);

const Choice = ({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) => (
  <PanelSectionRow>
    <ButtonItem layout="below" onClick={onClick}>
      <span style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0, textAlign: "left" }}>
        <span style={{ width: "14px", color: "#23a55a", fontWeight: 700 }}>{selected ? "✓" : ""}</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      </span>
    </ButtonItem>
  </PanelSectionRow>
);

export function AudioDevicesPanel() {
  const [mics, setMics] = useState<Device[] | null>(null);
  const [mic, setMicState] = useState(getMicId());
  const [outs, setOuts] = useState<Outputs | null>(null);

  const load = () => {
    listMics().then(setMics).catch(() => setMics([]));
    call<[], Outputs>("get_audio_outputs").then(setOuts).catch(() => {});
  };
  useEffect(load, []);

  return (
    <>
      <Heading>Microphone</Heading>
      {mics === null && <PanelSectionRow><div style={{ fontSize: "12px", opacity: 0.7 }}>Loading...</div></PanelSectionRow>}
      {mics?.map((d) => (
        <Choice
          key={d.id}
          label={d.label}
          selected={mic === d.id || (mic === "default" && d.id === "default")}
          onClick={async () => {
            setMicState(d.id);
            try {
              await setMic(d.id);
              toaster.toast({ title: "Discordio", body: `Microphone: ${d.label}` });
            } catch (e) {
              toaster.toast({ title: "Discordio", body: `Couldn't switch microphone: ${e}` });
            }
          }}
        />
      ))}

      <Heading>Speaker / headset</Heading>
      {outs?.error && (
        <PanelSectionRow>
          <div style={{ fontSize: "12px", color: "#ff6b6b" }}>{outs.error}</div>
        </PanelSectionRow>
      )}
      {outs === null && <PanelSectionRow><div style={{ fontSize: "12px", opacity: 0.7 }}>Loading...</div></PanelSectionRow>}
      {outs?.outputs?.map((d) => (
        <Choice
          key={d.id}
          label={d.name}
          selected={outs.output === d.id}
          onClick={async () => {
            const res = await call<[string], Outputs>("set_audio_output", d.id);
            if (res && !res.error) setOuts(res);
            toaster.toast({ title: "Discordio", body: res?.error ? res.error : `Output: ${d.name}` });
          }}
        />
      ))}
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={load}>Refresh devices</ButtonItem>
      </PanelSectionRow>
    </>
  );
}
