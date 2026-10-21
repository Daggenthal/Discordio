import { call } from "@decky/api";
import { PanelSectionRow } from "@decky/ui";
import { useEffect, useState } from "react";

type Usage = {
  now?: { cpu: number | null; js_mb: number; js_total_mb: number; nodes: number } | null;
  avg_cpu?: number | null;
  peak_cpu?: number | null;
  peak_js_mb?: number | null;
  minutes?: number;
  error?: string;
};

const small = { fontSize: "12px", lineHeight: 1.45 };

// How much the hidden Discord page uses, live and over the last 10 minutes.
export function PageUsage() {
  const [u, setU] = useState<Usage | null>(null);
  useEffect(() => {
    const load = () => call<[], Usage>("get_page_usage").then(setU).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);
  if (!u) return null;
  const n = u.now;
  return (
    <>
      <PanelSectionRow>
        <div style={small}>
          <b>Discord Page Usage</b>
          {u.error ? (
            <div style={{ opacity: 0.7 }}>Not measurable right now: {u.error}</div>
          ) : (
            <>
              <div>
                Now: CPU {n?.cpu == null ? "measuring..." : `${n.cpu}%`} · Memory {n?.js_mb ?? "?"} MB · {n?.nodes ?? "?"} page elements
              </div>
              {u.avg_cpu != null && (
                <div style={{ opacity: 0.75 }}>
                  Last {u.minutes || 0} min: CPU avg {u.avg_cpu}%, peak {u.peak_cpu}% · Memory peak {u.peak_js_mb} MB
                </div>
              )}
              <div style={{ opacity: 0.6, fontSize: 11 }}>CPU is the share of one core Discord's page keeps busy.</div>
            </>
          )}
        </div>
      </PanelSectionRow>
    </>
  );
}
