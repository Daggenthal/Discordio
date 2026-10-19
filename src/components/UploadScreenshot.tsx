import { call, toaster } from "@decky/api";
import { ButtonItem, PanelSectionRow } from "@decky/ui";
import { useEffect, useState } from "react";

type Channel = { id: string; label: string };

const toDataUrl = async (url: string) => {
  const blob = await (await fetch(url)).blob();
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
};

// Your latest Steam screenshot, with one button per recent channel / DM.
// Buttons instead of a dropdown, so backing out never leaves Discordio.
export function UploadScreenshot() {
  const [shot, setShot] = useState<string | null>(null);
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [sending, setSending] = useState<string | null>(null);

  useEffect(() => {
    call<[], Channel[]>("get_recent_channels").then((c) => setChannels(Array.isArray(c) ? c : [])).catch(() => setChannels([]));
    try {
      SteamClient.Screenshots.GetLastScreenshotTaken().then((r: any) => r?.strUrl && setShot(`https://steamloopback.host/${r.strUrl}`));
    } catch (_) {}
  }, []);

  if (!shot) {
    return (
      <PanelSectionRow>
        <div style={{ fontSize: "12px", opacity: 0.7 }}>Take a Steam screenshot to share it here.</div>
      </PanelSectionRow>
    );
  }

  return (
    <>
      <PanelSectionRow>
        <img src={shot} style={{ width: "100%", borderRadius: "6px", display: "block" }} />
      </PanelSectionRow>
      {channels === null && (
        <PanelSectionRow>
          <div style={{ fontSize: "12px", opacity: 0.7 }}>Loading channels...</div>
        </PanelSectionRow>
      )}
      {channels?.length === 0 && (
        <PanelSectionRow>
          <div style={{ fontSize: "12px", opacity: 0.7 }}>Open a channel or DM in Discord once and it shows up here.</div>
        </PanelSectionRow>
      )}
      {channels?.map((c) => (
        <PanelSectionRow key={c.id}>
          <ButtonItem
            layout="below"
            disabled={!!sending}
            onClick={async () => {
              setSending(c.id);
              try {
                const res: any = await call("post_screenshot", c.id, await toDataUrl(shot));
                toaster.toast({ title: "Discordio", body: res?.error ? `Not sent: ${res.error}` : `Screenshot sent to ${c.label}` });
              } catch (e) {
                toaster.toast({ title: "Discordio", body: `Not sent: ${e}` });
              } finally {
                setSending(null);
              }
            }}
          >
            {sending === c.id ? "Sending..." : `Send to ${c.label}`}
          </ButtonItem>
        </PanelSectionRow>
      ))}
    </>
  );
}
