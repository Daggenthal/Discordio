import { DialogButton } from "@decky/ui";
import { useState } from "react";

// A colored button (green Call / Answer, red Decline) that still shows
// clearly when the controller is on it. A custom background hides Steam's
// own focus highlight, so this draws its own: white ring, brighter, a
// touch bigger.
export function ColorButton({
  color,
  onClick,
  disabled,
  children,
  style,
}: {
  style?: any;
  color: string;
  onClick: () => void;
  disabled?: boolean;
  children: any;
}) {
  const [focused, setFocused] = useState(false);
  const on = () => setFocused(true);
  const off = () => setFocused(false);
  return (
    <DialogButton
      disabled={disabled}
      onClick={onClick}
      onFocus={on}
      onBlur={off}
      {...({ onGamepadFocus: on, onGamepadBlur: off } as any)}
      style={{
        flex: 1,
        minWidth: 0,
        background: color,
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        boxShadow: focused ? "0 0 0 3px #fff, 0 0 12px rgba(255,255,255,0.6)" : "none",
        filter: focused ? "brightness(1.2)" : "none",
        transform: focused ? "scale(1.03)" : "none",
        transition: "box-shadow .1s, filter .1s, transform .1s",
        ...(style || {}),
      }}
    >
      {children}
    </DialogButton>
  );
}
