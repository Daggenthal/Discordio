import { call, toaster } from "@decky/api";
import { ButtonItem, PanelSectionRow, ToggleField } from "@decky/ui";
import { useState } from "react";
import { note } from "../../lib/diag";

// R5 on the Steam Deck. Any controller button can be learned instead, which
// matters on a Steam Machine where the pad may not have Deck-style back buttons.
const DEFAULT_PTT_BUTTON = 33;
const KEY_BUTTON = "DECKCORD_PTT_BUTTON";

const getPttButton = () => {
  try {
    const v = parseInt(localStorage.getItem(KEY_BUTTON) || "", 10);
    if (!isNaN(v)) return v;
  } catch (_) {}
  return DEFAULT_PTT_BUTTON;
};

// Module level so the registration survives the QAM panel closing.
// (In the original it lived in a per-render variable and could never be
// unregistered, so PTT could not actually be turned off.)
let unregisterPtt: (() => void) | undefined;
let pttEnabled = false;
let learning: ((button: number) => void) | undefined;

const register = () => {
  if (unregisterPtt) return;
  try {
    const target = () => getPttButton();
    unregisterPtt = SteamClient.Input.RegisterForControllerInputMessages((events: any) => {
      for (const event of events) {
        if (learning && event.bS) {
          const cb = learning;
          learning = undefined;
          cb(event.nA);
          continue;
        }
        if (pttEnabled && event.nA == target()) call("set_ptt", event.bS);
      }
    }).unregister;
    note("Controller input hook", true);
  } catch (e) {
    note("Controller input hook", false, String(e));
  }
};

const unregisterIfIdle = () => {
  if (!pttEnabled && !learning && unregisterPtt) {
    try {
      unregisterPtt();
    } catch (_) {}
    unregisterPtt = undefined;
  }
};

export const cleanupPtt = () => {
  pttEnabled = false;
  learning = undefined;
  unregisterIfIdle();
};

export function PushToTalkButton() {
  const [enabled, setEnabled] = useState(pttEnabled);
  const [button, setButton] = useState(getPttButton());
  const [waiting, setWaiting] = useState(false);

  return (
    <>
      <PanelSectionRow>
        <ToggleField
          label="Push to talk"
          description={`Hold controller button ${button} to talk`}
          checked={enabled}
          onChange={(checked) => {
            setEnabled(checked);
            pttEnabled = checked;
            call("enable_ptt", checked);
            if (checked) {
              register();
              toaster.toast({ title: "Push-To-Talk", body: `Hold button ${button} to talk` });
            } else {
              unregisterIfIdle();
            }
          }}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem
          layout="below"
          disabled={waiting}
          onClick={() => {
            setWaiting(true);
            register();
            // Short delay so the A press that activated this button is not
            // itself captured as the push-to-talk button.
            setTimeout(() => {
            learning = (b) => {
              try {
                localStorage.setItem(KEY_BUTTON, String(b));
              } catch (_) {}
              setButton(b);
              setWaiting(false);
              toaster.toast({ title: "Push-To-Talk", body: `Button ${b} saved` });
              unregisterIfIdle();
            };
            }, 600);
          }}
        >
          {waiting ? "Press a controller button..." : "Choose push-to-talk button"}
        </ButtonItem>
      </PanelSectionRow>
    </>
  );
}
