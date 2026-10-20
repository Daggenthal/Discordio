import { call, toaster } from "@decky/api";
import { ButtonItem, PanelSection, PanelSectionRow } from "@decky/ui";
import { FaDownload } from "react-icons/fa";
import { ColorButton } from "./ColorButton";
import { useEffect, useState } from "react";
import { note } from "../lib/diag";
import { clearUpdating, markUpdating } from "../lib/reopen";
import { Navigation } from "@decky/ui";

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

// Checked whenever Discordio is opened (at most every 2 minutes), never in
// the background. Shared by the banner at the top and the panel at the
// bottom; when an update shows up, both refresh on their own.
let cached: UpdateInfo | null = null;
let checking: Promise<UpdateInfo> | null = null;
const subscribers = new Set<(i: UpdateInfo) => void>();
let lastCheck = 0;

const checkNow = async (): Promise<UpdateInfo> => {
  if (checking) return checking;
  checking = call<[], UpdateInfo>("get_update_info")
    .then((res) => {
      cached = res;
      lastCheck = Date.now();
      note("Update check", !res.error, res.error ?? (res.available ? `build ${res.latest_build} available` : "up to date"));
      subscribers.forEach((fn) => fn(res));
      return res;
    })
    .finally(() => {
      checking = null;
    });
  return checking;
};

function useUpdateInfo() {
  const [info, setInfo] = useState<UpdateInfo | null>(cached);
  useEffect(() => {
    subscribers.add(setInfo);
    // Every time Discordio is opened, but not more than once per 2 minutes
    // (one small request; GitHub also limits how often it can be asked).
    if (!cached || Date.now() - lastCheck > 2 * 60 * 1000) checkNow().catch(() => {});
    return () => {
      subscribers.delete(setInfo);
    };
  }, []);
  return info;
}

// Across the top of Discordio when a newer build is out.
export function UpdateBanner() {
  const info = useUpdateInfo();
  const [busy, setBusy] = useState(false);
  if (!info?.available) return null;
  const current = info.current_build ? `build ${info.current_build}` : info.current || "local build";
  return (
    <PanelSection title="Update available">
      <PanelSectionRow>
        <div style={{ fontSize: 12, lineHeight: "16px" }}>
          <b>{info.latest}</b> is out (you have {current}).
          {info.notes && <div style={{ opacity: 0.75, marginTop: 2 }}>{info.notes.split("\n")[0]}</div>}
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <ColorButton
          color="#5865f2"
          disabled={busy}
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
          <FaDownload /> {busy ? "Updating..." : "Update now"}
        </ColorButton>
      </PanelSectionRow>
    </PanelSection>
  );
}

const install = async (info: UpdateInfo) => {
  const backend = (window as any).DeckyBackend;
  if (!backend?.call || !info.url) {
    toaster.toast({ title: "Discordio", body: "This Decky version can't install updates from plugins" });
    return;
  }
  // Discordio reloads after installing: say so, and leave a note so the new
  // build reopens itself (see lib/reopen.ts).
  toaster.toast({
    title: "Updating Discordio",
    body: "It will close for a moment while it installs, then reopen by itself",
    duration: 6000,
  } as any);
  markUpdating(info.current_build, info.latest);
  // Same call Decky's "Install plugin from URL" uses. Decky shows its own
  // confirmation dialog, downloads the zip, swaps the files and reloads the
  // plugin, with no Desktop Mode trip or Decky restart.
  try {
    try {
      Navigation.CloseSideMenus();
    } catch (_) {}
    await backend.call(
    "utilities/install_plugin",
    info.url,
    "Discordio",
    info.version ?? "",
    false,
    info.current_build ? INSTALL_TYPE_UPDATE : INSTALL_TYPE_OVERWRITE
  );
  } catch (e) {
    clearUpdating(); // no reload is coming
    throw e;
  }
};

export function UpdatePanel() {
  const info = useUpdateInfo();
  const [busy, setBusy] = useState(false);

  const check = async () => {
    setBusy(true);
    try {
      await checkNow();
    } finally {
      setBusy(false);
    }
  };

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
