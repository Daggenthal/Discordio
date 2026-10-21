import { call } from "@decky/api";
import { DialogButton, Focusable, PanelSection, PanelSectionRow } from "@decky/ui";
import { useEffect, useRef, useState } from "react";
import { closeProfile } from "../lib/profile";

type Profile = {
  id: string; me: boolean; name: string; username: string | null; avatar: string | null; decoration: string | null;
  banner: string | null; banner_color: string | null; theme: [string, string] | null;
  tag: { text: string | null; badge: string | null } | null; pronouns: string | null; bio: string;
  status: string; custom: { text: string; emoji: string | null } | null;
  playing: { type: number; name: string; details: string | null; state: string | null }[];
  badges: { id: string; description: string; icon: string | null }[];
  member_since: string | null; connections: { type: string; label: string; name: string; verified: boolean }[];
  mutual_friends: number | null; mutual_servers: number | null; note: string | null; error?: string;
};

const STATUS: Record<string, string> = { online: "#23a55a", idle: "#f0b232", dnd: "#f23f43", offline: "#80848e", invisible: "#80848e" };
const PLAYING: Record<number, string> = { 0: "Playing", 1: "Streaming", 2: "Listening to", 3: "Watching", 5: "Competing in" };

// A block the controller can stop on, so long profiles scroll with the
// D-pad; it lights up while selected.
function Block({ children, pad = true }: { children: any; pad?: boolean }) {
  const [f, setF] = useState(false);
  return (
    <PanelSectionRow>
      <Focusable
        onActivate={() => {}}
        {...({ onGamepadFocus: () => setF(true), onGamepadBlur: () => setF(false) } as any)}
        style={{
          borderRadius: 8, padding: pad ? "6px 8px" : 0, margin: pad ? "0 -8px" : 0,
          background: f ? "rgba(255,255,255,0.1)" : "transparent",
          boxShadow: f ? "0 0 0 2px rgba(255,255,255,0.8)" : "none",
        }}
      >
        {children}
      </Focusable>
    </PanelSectionRow>
  );
}

const head = { fontSize: 12, fontWeight: 700, opacity: 0.75, marginBottom: 3 } as const;

// Discord-style profile, inside the Quick Access Menu.
export function ProfilePanel({ userId }: { userId: string | null }) {
  const [p, setP] = useState<Profile | null>(null);
  const [badge, setBadge] = useState<number | null>(null);
  const backRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setP(null);
    call<[string | null], Profile>("get_profile", userId)
      .then(setP)
      .catch((e) => setP({ error: String(e) } as any));
    setTimeout(() => {
      try {
        backRef.current?.scrollIntoView({ block: "start" });
        backRef.current?.querySelector<HTMLElement>("button, .DialogButton")?.focus();
      } catch (_) {}
    }, 120);
  }, [userId]);

  const [c1, c2] = p?.theme ?? ["#2b2d31", "#2b2d31"];
  const ring = p?.theme ? c1 : "#2b2d31";
  const back = (
    <PanelSectionRow>
      <DialogButton onClick={closeProfile}>← Back</DialogButton>
    </PanelSectionRow>
  );

  return (
    <PanelSection title={p?.me ? "Your Profile" : "Profile"}>
      <div ref={backRef}>{back}</div>
      {!p && <PanelSectionRow><div style={{ fontSize: 12, opacity: 0.7 }}>Loading profile...</div></PanelSectionRow>}
      {p?.error && <PanelSectionRow><div style={{ fontSize: 12, color: "#ff6b6b" }}>Couldn't load the profile: {p.error}</div></PanelSectionRow>}
      {p && !p.error && (
        <>
          {/* Card top: banner, avatar with decoration, name, tag and badges */}
          <PanelSectionRow>
            <div style={{ borderRadius: 12, overflow: "hidden", background: p.theme ? `linear-gradient(180deg, ${c1}, ${c2})` : "#2b2d31" }}>
              <div style={{ height: 96, background: p.banner ? `center / cover no-repeat url(${p.banner})` : p.banner_color || c1 || "#5865f2" }} />
              <div style={{ position: "relative", height: 40 }}>
                <div style={{ position: "absolute", top: -40, left: 12, width: 80, height: 80 }}>
                  <div style={{ width: 80, height: 80, borderRadius: "50%", border: `5px solid ${ring}`, boxSizing: "border-box", overflow: "hidden", background: "#111" }}>
                    {p.avatar && <img src={p.avatar} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                  </div>
                  {p.decoration && <img src={p.decoration} style={{ position: "absolute", inset: -9, width: 98, height: 98, pointerEvents: "none" }} />}
                  <span style={{ position: "absolute", right: 2, bottom: 2, width: 18, height: 18, borderRadius: "50%", background: STATUS[p.status] || STATUS.offline, border: `4px solid ${ring}`, boxSizing: "border-box" }} />
                </div>
              </div>
              <div style={{ padding: "4px 12px 12px", color: "#fff" }}>
                <div style={{ fontSize: 20, fontWeight: 800, wordBreak: "break-word" }}>{p.name}</div>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 4, fontSize: 12 }}>
                  {p.username && <span style={{ opacity: 0.9 }}>{p.username}</span>}
                  {p.pronouns && <span style={{ opacity: 0.7 }}>· {p.pronouns}</span>}
                  {p.tag?.text && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "rgba(0,0,0,0.25)", borderRadius: 6, padding: "1px 6px", fontWeight: 700 }}>
                      {p.tag.badge && <img src={p.tag.badge} style={{ width: 13, height: 13 }} />}
                      {p.tag.text}
                    </span>
                  )}
                </div>
                {p.custom && (p.custom.text || p.custom.emoji) && (
                  <div style={{ marginTop: 8, background: "rgba(0,0,0,0.25)", borderRadius: 10, padding: "7px 10px", fontSize: 12, lineHeight: 1.4, display: "flex", gap: 6 }}>
                    {p.custom.emoji && (p.custom.emoji.startsWith("http") ? <img src={p.custom.emoji} style={{ width: 16, height: 16, flex: "none" }} /> : <span>{p.custom.emoji}</span>)}
                    <span style={{ wordBreak: "break-word" }}>{p.custom.text}</span>
                  </div>
                )}
              </div>
            </div>
          </PanelSectionRow>
          {/* Badges: move onto one to read it */}
          {!!p.badges.length && (
            <PanelSectionRow>
              <Focusable style={{ display: "flex", flexWrap: "wrap", gap: 4 }} flow-children="row">
                {p.badges.map((b, i) => (
                  <Focusable
                    key={b.id}
                    onActivate={() => setBadge(badge === i ? null : i)}
                    {...({ onGamepadFocus: () => setBadge(i) } as any)}
                    style={{
                      width: 30, height: 30, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
                      border: badge === i ? "2px solid #fff" : "2px solid transparent", boxSizing: "border-box",
                      background: badge === i ? "rgba(255,255,255,0.15)" : "transparent",
                    }}
                  >
                    {b.icon && <img src={b.icon} style={{ width: 20, height: 20 }} />}
                  </Focusable>
                ))}
              </Focusable>
              {badge !== null && p.badges[badge] && (
                <div style={{ fontSize: 12, marginTop: 6, lineHeight: 1.35 }}>{p.badges[badge].description}</div>
              )}
            </PanelSectionRow>
          )}
          {p.playing.map((a, i) => (
            <Block key={`a${i}`}>
              <div style={head}>Activity</div>
              <div style={{ fontSize: 13 }}>
                {PLAYING[a.type] ?? "Playing"} <b>{a.name}</b>
                {a.details && <div style={{ opacity: 0.7, fontSize: 12 }}>{a.details}</div>}
                {a.state && <div style={{ opacity: 0.7, fontSize: 12 }}>{a.state}</div>}
              </div>
            </Block>
          ))}
          {/* Bio in paragraphs, each a stop, so a long one scrolls */}
          {p.bio &&
            p.bio.split(/\n{2,}/).map((para, i) => (
              <Block key={`b${i}`}>
                {i === 0 && <div style={head}>Bio</div>}
                <div style={{ fontSize: 13, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{para}</div>
              </Block>
            ))}
          {p.member_since && (
            <Block>
              <div style={head}>Member Since</div>
              <div style={{ fontSize: 13 }}>{p.member_since}</div>
              {!p.me && (p.mutual_friends || p.mutual_servers) ? (
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                  {[p.mutual_friends ? `${p.mutual_friends} mutual friend${p.mutual_friends > 1 ? "s" : ""}` : "",
                    p.mutual_servers ? `${p.mutual_servers} mutual server${p.mutual_servers > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ")}
                </div>
              ) : null}
            </Block>
          )}
          {p.connections.map((c, i) => (
            <Block key={`c${i}`}>
              {i === 0 && <div style={head}>Connections</div>}
              <div style={{ fontSize: 13 }}>
                <span style={{ opacity: 0.7 }}>{c.label}</span> · <b>{c.name}</b> {c.verified ? "✔" : ""}
              </div>
            </Block>
          ))}
          {p.note && (
            <Block>
              <div style={head}>Note (only visible to you)</div>
              <div style={{ fontSize: 13, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{p.note}</div>
            </Block>
          )}
          {back}
        </>
      )}
    </PanelSection>
  );
}
