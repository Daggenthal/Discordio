import { toaster } from "@decky/api";
import { ButtonItem, PanelSectionRow, ToggleField } from "@decky/ui";
import { useEffect, useState } from "react";
import { ChoiceSlider } from "../ChoiceSlider";
import {
  Action,
  MicMode,
  describe,
  getBindings,
  learning,
  startLearning,
  startShortcuts,
  stopShortcuts,
  subscribe,
  update,
} from "../../lib/shortcuts";

// Kept for index.tsx's existing imports.
export const startMicShortcut = startShortcuts;
export const cleanupPtt = stopShortcuts;

function useShortcuts() {
  const [, force] = useState(0);
  useEffect(() => subscribe(() => force((n) => n + 1)), []);
  return getBindings();
}

const LABEL: Record<Action, string> = { mic: "mic button", answer: "answer shortcut", decline: "decline shortcut" };

// Blank: "Set Keybind" (press the buttons). Set: the keybind shows under the
// shortcut's name, and "Reset Keybind" (press twice) clears it again.
function LearnButton({ action, hint }: { action: Action; hint: string }) {
  const l = learning();
  const mine = !!l && l.action === action;
  const b = getBindings()[action];
  const has = BigInt(b.mask || "0") !== 0n;
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 4000);
    return () => clearTimeout(t);
  }, [confirm]);

  if (has && !mine) {
    return (
      <PanelSectionRow>
        <ButtonItem
          layout="below"
          onClick={() => {
            if (!confirm) return setConfirm(true);
            setConfirm(false);
            update(action, { mask: "0", enabled: false });
            toaster.toast({ title: "Discordio", body: `${LABEL[action][0].toUpperCase() + LABEL[action].slice(1)} cleared` });
          }}
        >
          <span style={{ color: confirm ? "#fff" : "#ff6b6b" }}>{confirm ? "Press Again to Reset" : "Reset Keybind"}</span>
        </ButtonItem>
      </PanelSectionRow>
    );
  }
  return (
    <PanelSectionRow>
      <ButtonItem
        layout="below"
        disabled={!!l && !mine}
        description={mine ? "Hold the buttons together, then let go" : hint}
        onClick={() =>
          startLearning(action, (mask) =>
            toaster.toast({
              title: "Discordio",
              body: mask ? `${LABEL[action][0].toUpperCase() + LABEL[action].slice(1)}: ${describe(mask)}` : "No controller input reached Discordio. See Diagnostics.",
            })
          )
        }
      >
        {mine ? (l!.union ? `Got: ${describe(l!.union.toString())}` : "Waiting for buttons...") : "Set Keybind"}
      </ButtonItem>
    </PanelSectionRow>
  );
}

const MODES = [
  { value: "mute", short: "Toggle mute", label: "Press to mute / unmute" },
  { value: "ptt", short: "Push to talk", label: "Hold to talk" },
];

// In the Call section: a controller button for the microphone.
export function PushToTalkButton() {
  const b = useShortcuts().mic;
  const has = BigInt(b.mask || "0") !== 0n;
  return (
    <>
      <PanelSectionRow>
        <ToggleField
          label="Mic button"
          description={has ? `${describe(b.mask)}: ${b.mode === "mute" ? "press to mute / unmute" : "hold to talk"}` : "No keybind set"}
          checked={b.enabled && has}
          disabled={!has}
          onChange={(v) => update("mic", { enabled: v })}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ChoiceSlider label="Mic button does" choices={MODES} value={b.mode} onChange={(v) => update("mic", { mode: v as MicMode })} />
      </PanelSectionRow>
      <LearnButton action="mic" hint="A combination like Create + R3 won't clash with your games" />
    </>
  );
}

// In Settings: answering and declining calls from the controller.
export function CallShortcutsPanel() {
  const s = useShortcuts();
  return (
    <>
      <PanelSectionRow>
        <div style={{ fontWeight: 700, fontSize: "13px", marginTop: "6px" }}>Call shortcuts</div>
      </PanelSectionRow>
      <PanelSectionRow>
        <div style={{ fontSize: "11px", opacity: 0.7 }}>
          Only active while someone is calling you. They read the physical buttons, so they work with any controller layout.
        </div>
      </PanelSectionRow>
      {(["answer", "decline"] as const).map((a) => {
        const has = BigInt(s[a].mask || "0") !== 0n;
        return (
          <div key={a}>
            <PanelSectionRow>
              <ToggleField
                label={a === "answer" ? "Answer" : "Decline"}
                description={has ? describe(s[a].mask) : "No keybind set"}
                checked={s[a].enabled && has}
                disabled={!has}
                onChange={(v) => update(a, { enabled: v })}
              />
            </PanelSectionRow>
            <LearnButton action={a} hint={`For example: hold Options/Start, then tap ${a === "answer" ? "R2" : "L2"}`} />
          </div>
        );
      })}
    </>
  );
}
