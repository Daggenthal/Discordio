import { call } from "@decky/api";
import { Focusable, PanelSectionRow } from "@decky/ui";
import { useEffect, useState } from "react";

type Badge = { id: string; description: string; icon: string | null };

let cache: { at: number; badges: Badge[]; facts: string[] } | null = null;

// Your Discord profile badges. Moving onto one shows what it is.
export function Badges({ userId }: { userId?: string }) {
  const [badges, setBadges] = useState<Badge[] | null>(cache?.badges ?? null);
  const [focused, setFocused] = useState<Badge | null>(null);

  useEffect(() => {
    if (cache && Date.now() - cache.at < 10 * 60_000) return;
    call<[], { badges?: Badge[]; facts?: string[]; error?: string }>("get_badges")
      .then((r) => {
        const list = r?.badges ?? [];
        cache = { at: Date.now(), badges: list, facts: r?.facts ?? [] };
        setBadges(list);
      })
      .catch(() => setBadges([]));
  }, [userId]);

  if (!badges?.length) return null;
  return (
    <PanelSectionRow>
      <div style={{ padding: "2px 0 4px" }}>
        {!!badges?.length && (
        <Focusable style={{ display: "flex", flexWrap: "wrap", gap: 4 }} flow-children="row">
          {badges.map((b) => (
            <Focusable
              key={b.id}
              onActivate={() => setFocused(focused?.id === b.id ? null : b)}
              onOKActionDescription="What's this?"
              {...({ onGamepadFocus: () => setFocused(b), onGamepadBlur: () => setFocused((f) => (f?.id === b.id ? null : f)) } as any)}
              style={{
                width: 30, height: 30, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
                background: focused?.id === b.id ? "rgba(255,255,255,0.15)" : "transparent",
                border: focused?.id === b.id ? "2px solid #fff" : "2px solid transparent", boxSizing: "border-box",
              }}
            >
              {b.icon ? <img src={b.icon} alt="" style={{ width: 20, height: 20 }} /> : <span style={{ fontSize: 10 }}>?</span>}
            </Focusable>
          ))}
        </Focusable>
        )}
        {focused && <div style={{ fontSize: 12, opacity: 0.9, marginTop: 6, lineHeight: 1.35 }}>{focused.description}</div>}

      </div>
    </PanelSectionRow>
  );
}
