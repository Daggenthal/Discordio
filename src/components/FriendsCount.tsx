import { call } from "@decky/api";
import { useEffect, useState } from "react";

// "3 online · 120 friends", shown above your name.
export function FriendsCount() {
  const [counts, setCounts] = useState<{ online: number; total: number } | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      call<[string, null], any>("discord_query", "friends", null)
        .then((r) => {
          if (!alive || !Array.isArray(r)) return;
          setCounts({ online: r.filter((f: any) => f.status && f.status !== "offline").length, total: r.length });
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (!counts) return null;
  return (
    <div style={{ fontSize: 12, opacity: 0.8, display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#23a55a", display: "inline-block" }} />
      {counts.online} online · {counts.total} friends
    </div>
  );
}
