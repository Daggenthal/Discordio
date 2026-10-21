import { call } from "@decky/api";
import { Focusable, Navigation, Router } from "@decky/ui";
import { useEffect, useRef, useState } from "react";
import { profileTarget } from "../lib/profile";
import { expandLater } from "../lib/events";
import { openDiscordio } from "../lib/reopen";

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
const BTN = { UP: 9, DOWN: 10, LEFT: 11, RIGHT: 12, LT: 7, RT: 8 };

// A Discord-style profile card, full screen. B goes back to the Quick
// Access Menu; left / right pick a badge to read it; up / down scroll.
export function ProfileView() {
  const t = profileTarget();
  const [p, setP] = useState<Profile | null>(null);
  const [badge, setBadge] = useState(-1);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    call<[string | null], Profile>("get_profile", t?.userId ?? null)
      .then(setP)
      .catch((e) => setP({ error: String(e) } as any));
  }, []);

  const back = () => {
    if (t?.section) expandLater(t.section);
    try {
      Navigation.NavigateBack();
    } catch (_) {
      Router.Navigate("/library/home");
    }
    setTimeout(openDiscordio, 350);
  };
  const scroll = (dy: number) => scroller.current?.scrollBy({ top: dy, behavior: "smooth" });

  const [c1, c2] = p?.theme ?? ["#232428", "#232428"];
  const accent = p?.banner_color || c1 || "#5865f2";
  const section = { fontSize: 15, fontWeight: 700, margin: "18px 0 6px", color: "#fff" } as const;

  return (
    <Focusable
      style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.88)", display: "flex", justifyContent: "center" }}
      noFocusRing
      onCancelButton={back}
      onCancelActionDescription="Back"
      onGamepadDirection={(e: any) => {
        const b = e?.detail?.button;
        if (b === BTN.DOWN) scroll(160);
        if (b === BTN.UP) scroll(-160);
        if (p?.badges.length) {
          if (b === BTN.RIGHT) setBadge(Math.min(p.badges.length - 1, badge + 1));
          if (b === BTN.LEFT) setBadge(Math.max(-1, badge - 1));
        }
      }}
      onButtonDown={(e: any) => {
        const b = e?.detail?.button;
        if (b === BTN.RT) scroll(400);
        if (b === BTN.LT) scroll(-400);
      }}
    >
      <div ref={scroller} style={{ width: 620, maxWidth: "94vw", height: "100%", overflowY: "auto", padding: "28px 0" }}>
        {!p && <div style={{ color: "#fff", opacity: 0.7, marginTop: 80, textAlign: "center" }}>Loading profile...</div>}
        {p?.error && <div style={{ color: "#ff6b6b", marginTop: 80, textAlign: "center" }}>Couldn't load the profile: {p.error}</div>}
        {p && !p.error && (
          <div
            style={{
              borderRadius: 16, overflow: "hidden", color: "#dbdee1",
              background: p.theme ? `linear-gradient(180deg, ${c1}, ${c2})` : "#232428",
              boxShadow: "0 8px 40px rgba(0,0,0,0.6)",
            }}
          >
            {/* Banner */}
            <div style={{ height: 210, background: p.banner ? `center / cover no-repeat url(${p.banner})` : accent }} />
            {/* Avatar with decoration and status, custom status beside it */}
            <div style={{ position: "relative", height: 70, padding: "0 22px" }}>
              <div style={{ position: "absolute", top: -64, left: 22, width: 128, height: 128 }}>
                <div style={{ width: 128, height: 128, borderRadius: "50%", border: `7px solid ${p.theme ? c1 : "#232428"}`, boxSizing: "border-box", overflow: "hidden", background: "#111" }}>
                  {p.avatar && <img src={p.avatar} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                </div>
                {p.decoration && <img src={p.decoration} style={{ position: "absolute", inset: -14, width: 156, height: 156, pointerEvents: "none" }} />}
                <span
                  style={{
                    position: "absolute", right: 6, bottom: 6, width: 26, height: 26, borderRadius: "50%",
                    background: STATUS[p.status] || STATUS.offline, border: `6px solid ${p.theme ? c1 : "#232428"}`, boxSizing: "border-box",
                  }}
                />
              </div>
              {p.custom && (p.custom.text || p.custom.emoji) && (
                <div
                  style={{
                    position: "absolute", left: 168, right: 22, top: 10, background: "rgba(0,0,0,0.35)", borderRadius: 14,
                    padding: "10px 14px", fontSize: 15, color: "#fff", display: "flex", gap: 8, alignItems: "center",
                  }}
                >
                  {p.custom.emoji && (p.custom.emoji.startsWith("http") ? <img src={p.custom.emoji} style={{ width: 20, height: 20 }} /> : <span>{p.custom.emoji}</span>)}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" } as any}>{p.custom.text}</span>
                </div>
              )}
            </div>
            <div style={{ padding: "6px 24px 24px" }}>
              <div style={{ fontSize: 30, fontWeight: 800, color: "#fff" }}>{p.name}</div>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 6, fontSize: 16 }}>
                {p.username && <span>{p.username}</span>}
                {p.pronouns && <span style={{ opacity: 0.7 }}>· {p.pronouns}</span>}
                {p.tag?.text && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "rgba(255,255,255,0.08)", borderRadius: 8, padding: "3px 8px", fontWeight: 600 }}>
                    {p.tag.badge && <img src={p.tag.badge} style={{ width: 16, height: 16 }} />}
                    {p.tag.text}
                  </span>
                )}
                {!!p.badges.length && (
                  <span style={{ display: "inline-flex", gap: 4, background: "rgba(255,255,255,0.08)", borderRadius: 8, padding: "3px 6px" }}>
                    {p.badges.map((b, i) => (
                      <span key={b.id} style={{ borderRadius: 6, padding: 2, outline: i === badge ? "2px solid #fff" : "none" }}>
                        {b.icon && <img src={b.icon} style={{ width: 22, height: 22, display: "block" }} />}
                      </span>
                    ))}
                  </span>
                )}
              </div>
              {badge >= 0 && p.badges[badge] && (
                <div style={{ marginTop: 8, fontSize: 14, color: "#fff", background: "rgba(0,0,0,0.35)", borderRadius: 8, padding: "8px 12px" }}>
                  {p.badges[badge].description}
                </div>
              )}
              {p.playing.length > 0 && (
                <>
                  <div style={section}>Activity</div>
                  {p.playing.map((a, i) => (
                    <div key={i} style={{ fontSize: 15 }}>
                      {PLAYING[a.type] ?? "Playing"} <b style={{ color: "#fff" }}>{a.name}</b>
                      {a.details && <div style={{ opacity: 0.7, fontSize: 13 }}>{a.details}</div>}
                      {a.state && <div style={{ opacity: 0.7, fontSize: 13 }}>{a.state}</div>}
                    </div>
                  ))}
                </>
              )}
              {p.bio && (
                <>
                  <div style={section}>Bio</div>
                  <div style={{ fontSize: 16, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{p.bio}</div>
                </>
              )}
              {p.member_since && (
                <>
                  <div style={section}>Member Since</div>
                  <div style={{ fontSize: 16 }}>{p.member_since}</div>
                </>
              )}
              {!p.me && (p.mutual_friends || p.mutual_servers) ? (
                <div style={{ fontSize: 14, opacity: 0.75, marginTop: 14 }}>
                  {[p.mutual_friends ? `${p.mutual_friends} mutual friend${p.mutual_friends > 1 ? "s" : ""}` : "",
                    p.mutual_servers ? `${p.mutual_servers} mutual server${p.mutual_servers > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ")}
                </div>
              ) : null}
              {p.connections.length > 0 && (
                <>
                  <div style={section}>Connections</div>
                  {p.connections.map((c, i) => (
                    <div key={i} style={{ background: "rgba(255,255,255,0.06)", borderRadius: 12, padding: "12px 16px", marginBottom: 8, fontSize: 16 }}>
                      <span style={{ opacity: 0.7 }}>{c.label}</span> · <b style={{ color: "#fff" }}>{c.name}</b> {c.verified ? "✔" : ""}
                    </div>
                  ))}
                </>
              )}
              {p.note && (
                <>
                  <div style={section}>Note (only visible to you)</div>
                  <div style={{ fontSize: 15, whiteSpace: "pre-wrap" }}>{p.note}</div>
                </>
              )}
              <div style={{ fontSize: 13, opacity: 0.55, marginTop: 22 }}>
                {p.badges.length ? "◀ ▶ read badges · " : ""}▲ ▼ scroll · B to go back
              </div>
            </div>
          </div>
        )}
      </div>
    </Focusable>
  );
}
