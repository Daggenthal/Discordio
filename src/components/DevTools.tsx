import { call, toaster } from "@decky/api";
import { ButtonItem, PanelSectionRow } from "@decky/ui";
import { useState } from "react";

// Hidden away in Diagnostics: experimental whole-screen capture (Quick
// Access Menu and overlays included), for README screenshots and GIFs.
export function DevTools() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const capture = async (what: string, frames: number) => {
    setBusy(what);
    toaster.toast({ title: "Discordio", body: frames > 1 ? "Recording starts in 3 seconds (8 seconds long)" : "Screenshot in 3 seconds" });
    try {
      const res: any = await call("capture_ui", frames, 6, 3);
      toaster.toast({
        title: "Discordio",
        body: res?.error ? `Capture failed: ${res.error}` : frames > 1 ? `${res.files.length} frames saved in ${res.dir}` : `Saved ${res.files?.[0]}`,
        duration: 8000,
      } as any);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"} Developer Tools (experimental)
        </ButtonItem>
      </PanelSectionRow>
      {open && (
        <>
          <PanelSectionRow>
            <div style={{ fontSize: 11, opacity: 0.7, lineHeight: 1.4 }}>
              Captures the whole screen, Quick Access Menu included, into Pictures/Discordio in your home folder. You get 3
              seconds to get the screen ready.
            </div>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" disabled={!!busy} onClick={() => capture("shot", 1)}>
              {busy === "shot" ? "Taking screenshot..." : "Screenshot the Whole Screen"}
            </ButtonItem>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={!!busy}
              description="About 6 frames a second for 8 seconds, as numbered PNGs to turn into a GIF"
              onClick={() => capture("gif", 48)}
            >
              {busy === "gif" ? "Recording..." : "Record Frames for a GIF"}
            </ButtonItem>
          </PanelSectionRow>
        </>
      )}
    </>
  );
}
