import { Focusable, Navigation, Router } from "@decky/ui";
import { useEffect, useRef, useState } from "react";
import { closeViewer, viewerState } from "../lib/viewer";
import { expandLater } from "../lib/events";
import { openDiscordio } from "../lib/reopen";

const BTN_LEFT = 11, BTN_RIGHT = 12, BUMPER_LEFT = 5, BUMPER_RIGHT = 6;

// The image / GIF / video, as big as the screen allows. B goes back to the
// conversation in the Quick Access Menu; left / right switch between the
// pictures of that message; A plays or pauses a video.
export function MediaViewer() {
  const st = viewerState();
  const [index, setIndex] = useState(st?.index ?? 0);
  const video = useRef<HTMLVideoElement>(null);
  const items = st?.items ?? [];
  const m = items[index];

  const back = () => {
    closeViewer();
    expandLater("Messages");
    try {
      Navigation.NavigateBack();
    } catch (_) {
      Router.Navigate("/library/home");
    }
    setTimeout(openDiscordio, 350);
  };
  useEffect(() => {
    if (!st) back();
  }, []);
  if (!m) return null;

  const fill = { maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block" } as const;
  return (
    <Focusable
      style={{ position: "absolute", inset: 0, background: "#000", display: "flex", alignItems: "center", justifyContent: "center" }}
      noFocusRing
      onCancelButton={back}
      onCancelActionDescription="Back"
      onOKButton={() => {
        const v = video.current;
        if (v) v.paused ? v.play().catch(() => {}) : v.pause();
      }}
      onOKActionDescription={m.kind === "video" ? "Play / Pause" : undefined}
      onGamepadDirection={(e: any) => {
        const b = e?.detail?.button;
        if (b === BTN_LEFT && index > 0) setIndex(index - 1);
        if (b === BTN_RIGHT && index < items.length - 1) setIndex(index + 1);
      }}
      onButtonDown={(e: any) => {
        const b = e?.detail?.button;
        if (b === BUMPER_LEFT && index > 0) setIndex(index - 1);
        if (b === BUMPER_RIGHT && index < items.length - 1) setIndex(index + 1);
      }}
    >
      {m.kind === "video" ? (
        <video ref={video} key={m.url} src={m.url} poster={m.poster} autoPlay controls={false} style={fill} />
      ) : m.kind === "gifv" ? (
        <video key={m.url} src={m.url} poster={m.poster} autoPlay loop muted playsInline style={fill} />
      ) : (
        <img key={m.url} src={m.url} style={fill} />
      )}
      <div style={{ position: "absolute", left: 24, bottom: 20, color: "#fff", fontSize: 15, textShadow: "0 1px 3px #000", opacity: 0.85 }}>
        {items.length > 1 ? `${index + 1} / ${items.length} · ◀ ▶ to switch · ` : ""}B to go back
      </div>
    </Focusable>
  );
}
