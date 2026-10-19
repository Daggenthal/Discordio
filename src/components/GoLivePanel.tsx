import { ButtonItem, DropdownItem, PanelSectionRow, Router } from "@decky/ui";
import { call, toaster } from "@decky/api";
import { useEffect, useState } from "react";
import { FaVideo, FaStop } from "react-icons/fa";
import { useDeckcordState } from "../hooks/useDeckcordState";

// Resolution / frame rate of the capture that Deckcord feeds to Discord.
// Discord still applies its own cap on top of this (720p30 without Nitro),
// so picking 1080p only helps if the account is allowed to send 1080p.
export const QUALITY_OPTIONS = [
  { data: "720p30", label: "720p 30 fps" },
  { data: "720p60", label: "720p 60 fps" },
  { data: "1080p30", label: "1080p 30 fps" },
  { data: "1080p60", label: "1080p 60 fps" },
  { data: "1440p60", label: "1440p 60 fps" },
  { data: "source", label: "Source (no scaling)" },
];

export function GoLivePanel() {
  const state = useDeckcordState();
  const [quality, setQuality] = useState<string>("720p30");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call<[], string>("get_stream_quality")
      .then((q) => q && setQuality(q))
      .catch(() => {});
  }, []);

  const inVoice = state?.vc && Object.keys(state.vc).length > 0;
  const live = !!state?.me?.is_live;

  const toggle = async () => {
    setBusy(true);
    try {
      const res: any = await call(live ? "stop_go_live" : "go_live");
      if (res && res.ok === false) {
        toaster.toast({
          title: "Discordio",
          body: res.error || "Could not start the stream",
        });
      } else if (res?.method === "ui" && !live) {
        // Discord's own button was used; it may want a confirmation, so show it.
        Router.Navigate("/discord");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PanelSectionRow>
        <DropdownItem
          label="Stream quality"
          description="Changes apply the next time you go live"
          rgOptions={QUALITY_OPTIONS}
          selectedOption={quality}
          onChange={(opt) => {
            setQuality(opt.data);
            call("set_stream_quality", opt.data);
          }}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem
          layout="below"
          disabled={!inVoice || busy}
          onClick={toggle}
          description={inVoice ? undefined : "Join a voice channel first"}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
            {live ? <FaStop /> : <FaVideo />}
            {live ? "Stop streaming" : "Go Live"}
          </span>
        </ButtonItem>
      </PanelSectionRow>
    </>
  );
}
