import { call, toaster } from "@decky/api";
import { ButtonItem, PanelSectionRow } from "@decky/ui";
import { useEffect, useState } from "react";
import { note } from "../lib/diag";

type UpdateInfo = {
  current: string;
  current_build: number;
  available: boolean;
  latest?: string;
  latest_build?: number;
  version?: string;
  url?: string;
  notes?: string;
  error?: string;
};

// Values of Decky's InstallType enum (frontend/src/plugin.ts).
const INSTALL_TYPE_UPDATE = 2;
const INSTALL_TYPE_OVERWRITE = 4;

// Checked once per Steam session unless the user asks again.
let cached: UpdateInfo | null = null;

const install = async (info: UpdateInfo) => {
  const backend = (window as any).DeckyBackend;
  if (!backend?.call || !info.url) {
    toaster.toast({ title: "Discordio", body: "This Decky version can't install updates from plugins" });
    return;
  }
  // Same call Decky's "Install plugin from URL" uses. Decky shows its own
  // confirmation dialog, downloads the zip, swaps the files and reloads the
  // plugin, with no Desktop Mode trip or Decky restart.
  await backend.call(
    "utilities/install_plugin",
    info.url,
    "Discordio",
    info.version ?? "",
    false,
    info.current_build ? INSTALL_TYPE_UPDATE : INSTALL_TYPE_OVERWRITE
  );
};

export function UpdatePanel() {
  const [info, setInfo] = useState<UpdateInfo | null>(cached);
  const [busy, setBusy] = useState(false);

  const check = async () => {
    setBusy(true);
    try {
      const res = await call<[], UpdateInfo>("get_update_info");
      cached = res;
      setInfo(res);
      note("Update check", !res.error, res.error ?? (res.available ? `build ${res.latest_build} available` : "up to date"));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!cached) check();
  }, []);

  const current = info?.current_build ? `build ${info.current_build}` : info?.current || "local build";

  return (
    <>
      {info?.available ? (
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={busy}
            description={`You have ${current}. ${info.notes ? info.notes.split("\n")[0] : ""}`}
            onClick={async () => {
              setBusy(true);
              try {
                await install(info);
              } catch (e) {
                toaster.toast({ title: "Discordio", body: `Update failed: ${e}` });
              } finally {
                setBusy(false);
              }
            }}
          >
            Update to {info.latest}
          </ButtonItem>
        </PanelSectionRow>
      ) : (
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={busy}
            description={
              info?.error
                ? `Couldn't check: ${info.error}`
                : info
                ? `Up to date (${current})`
                : "Checking..."
            }
            onClick={check}
          >
            {busy ? "Checking..." : "Check for updates"}
          </ButtonItem>
        </PanelSectionRow>
      )}
    </>
  );
}
