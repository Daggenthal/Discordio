import { Focusable } from "@decky/ui";
import { useState } from "react";

// A section's title that is itself the open / close control (instead of a
// separate "Show ..." button under it).
export function SectionHeader({ title, open, onToggle, badge }: { title: string; open: boolean; onToggle: () => void; badge?: number }) {
  const [focused, setFocused] = useState(false);
  return (
    <Focusable
      onActivate={onToggle}
      onOKActionDescription={open ? "Collapse" : "Show"}
      {...({ onGamepadFocus: () => setFocused(true), onGamepadBlur: () => setFocused(false) } as any)}
      style={{
        display: "flex", alignItems: "center", gap: 8, padding: "10px 10px", margin: "0 -10px", borderRadius: 6,
        fontWeight: 700, fontSize: 13, letterSpacing: "0.06em", textTransform: "uppercase", color: "#fff",
        background: focused ? "rgba(255,255,255,0.14)" : "transparent",
        boxShadow: focused ? "inset 0 0 0 2px rgba(255,255,255,0.75)" : "none",
      }}
    >
      <span style={{ flex: 1 }}>{title}</span>
      {!!badge && (
        <span style={{ background: "#ed4245", color: "#fff", borderRadius: 8, fontSize: 10, padding: "0 6px", letterSpacing: 0 }}>
          {badge > 99 ? "99+" : badge}
        </span>
      )}
      <span style={{ opacity: 0.6, fontSize: 14 }}>{open ? "▾" : "▸"}</span>
    </Focusable>
  );
}
