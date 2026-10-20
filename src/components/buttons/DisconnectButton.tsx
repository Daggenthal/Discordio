import { call } from "@decky/api";
import { DialogButton } from "@decky/ui";
import { useState } from "react";
import { FaPhoneSlash } from "react-icons/fa";

// Leave the call: red with a hang-up icon, like Discord's own button.
// Only shown while you're in a call (it does nothing otherwise).
export function DisconnectButton() {
  const [focused, setFocused] = useState(false);
  const on = () => setFocused(true);
  const off = () => setFocused(false);
  return (
    <DialogButton
      onClick={() => {
        call("disconnect_vc");
      }}
      onFocus={on}
      onBlur={off}
      {...({ onGamepadFocus: on, onGamepadBlur: off } as any)}
      style={{
        height: "40px",
        width: "40px",
        minWidth: 0,
        padding: "10px 12px",
        marginRight: "10px",
        background: "#da373c",
        color: "#fff",
        boxShadow: focused ? "0 0 0 3px #fff, 0 0 12px rgba(255,255,255,0.6)" : "none",
        filter: focused ? "brightness(1.2)" : "none",
      }}
    >
      <FaPhoneSlash />
    </DialogButton>
  );
}
