import { call } from "@decky/api";
import { PanelSectionRow } from "@decky/ui";
import { useEffect, useState } from "react";

// Steam's own view of the machine (version, GPU...). No hostname or IDs.
export async function steamSystemInfo(): Promise<Record<string, any>> {
  try {
    const s: any = await (window as any).SteamClient?.System?.GetSystemInfo?.();
    if (!s) return {};
    return {
      version: s.nSteamVersion,
      build_date: s.sSteamBuildDate,
      gpu: s.sVideoCardName,
      gpu_driver: s.sVideoDriverVersion,
      cpu: s.sCPUName,
      ram_mb: s.nSystemRAMSizeMB,
      bios: s.sBIOSVersion,
    };
  } catch (_) {
    return {};
  }
}

// Shown in Diagnostics, and included in reports: which SteamOS / Steam
// channel and build someone is on makes problems much easier to place.
export function SystemInfo() {
  const [info, setInfo] = useState<Record<string, any> | null>(null);
  const [steam, setSteam] = useState<Record<string, any>>({});
  useEffect(() => {
    call<[], Record<string, any>>("get_system_info").then(setInfo).catch(() => {});
    steamSystemInfo().then(setSteam);
  }, []);
  if (!info) return null;
  const rows: [string, string][] = [
    ["SteamOS", `${info.os_version ?? "?"} (build ${info.os_build ?? "?"}) · ${info.steamos_channel ?? "?"} channel`],
    ["Steam", `${steam.version ?? "?"}${steam.build_date ? ` (${steam.build_date})` : ""} · ${info.steam_client_channel ?? "?"}`],
    ["Hardware", info.hardware || "?"],
    ["GPU", [steam.gpu, steam.gpu_driver].filter(Boolean).join(" · ") || "?"],
    ["Kernel", info.kernel || "?"],
    ["Decky", info.decky || "?"],
    ["Discordio", `${info.discordio} · ${info.discordio_update_channel === "beta" ? "Beta" : "Stable"} updates`],
  ];
  return (
    <PanelSectionRow>
      <div style={{ fontSize: 12, lineHeight: 1.45 }}>
        <b>System</b>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "flex", gap: 6 }}>
            <span style={{ opacity: 0.6, flex: "none", width: 68 }}>{k}</span>
            <span style={{ minWidth: 0, wordBreak: "break-word" }}>{v}</span>
          </div>
        ))}
      </div>
    </PanelSectionRow>
  );
}
