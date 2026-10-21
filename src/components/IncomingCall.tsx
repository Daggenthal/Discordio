import { addEventListener, call, removeEventListener, toaster } from "@decky/api";
import { Focusable, Navigation, PanelSection, PanelSectionRow } from "@decky/ui";
import { useEffect, useRef, useState } from "react";
import { FaPhone, FaPhoneSlash } from "react-icons/fa";
import { ColorButton } from "./ColorButton";
import { Avatar } from "./VoiceChatViews";
import { callHint, setRinging } from "../lib/shortcuts";

type Incoming = {
  channel_id: string;
  caller: { id: string | null; name: string; avatar: string | null };
  group?: string | null;
} | null;

// Steam notification when a call comes in; selecting it opens Discordio's
// panel, where the Answer / Decline buttons are. Registered once at load.
export function startCallNotifications() {
  const onCall = (c: any) => {
    // The controller shortcuts only act while this is set.
    setRinging(c?.ringing ? c.channel_id : null);
    if (!c?.ringing) return;
    const caller = c.caller || {};
    // The overlay's call card (where message popups appear) says it already;
    // the Steam notification is only for when the overlay can't show it.
    if (c.overlay === true) return;
    if (c.overlay === false) setTimeout(() => toast(), 0);
    else
      call<[], boolean>("call_card_shown")
        .then((shown) => !shown && toast())
        .catch(() => toast());
    const toast = () => toaster.toast({
      title: `${caller.name || "Someone"} is calling${c.group ? ` (${c.group})` : ""}`,
      body: callHint(),
      logo: caller.avatar ? <img src={caller.avatar} style={{ borderRadius: "50%", width: "100%" }} /> : undefined,
      duration: 12000,
      onClick: () => {
        try {
          Navigation.OpenQuickAccessMenu(999 as any); // the Decky tab (QuickAccessTab is type-only)
        } catch (_) {}
      },
    } as any);
  };
  addEventListener("call", onCall);
  // A call already ringing when the plugin loaded.
  call<[], any>("get_incoming_call").then((c) => c && setRinging(c.channel_id)).catch(() => {});
  return () => {
    setRinging(null);
    removeEventListener("call", onCall);
  };
}

// Banner at the top of Discordio while a call is ringing.
export function IncomingCallBanner() {
  const [incoming, setIncoming] = useState<Incoming>(null);
  const [busy, setBusy] = useState(false);
  const answerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () => call<[], Incoming>("get_incoming_call").then(setIncoming).catch(() => {});
    load();
    const onCall = (c: any) => (c?.ringing ? setIncoming(c) : setIncoming(null));
    addEventListener("call", onCall);
    const t = setInterval(load, 2000);
    return () => {
      clearInterval(t);
      removeEventListener("call", onCall);
    };
  }, []);

  // Put the controller on Answer as soon as a call shows up.
  useEffect(() => {
    if (!incoming) return;
    const t = setTimeout(() => {
      try {
        answerRef.current?.querySelector<HTMLElement>("button, .DialogButton")?.focus();
      } catch (_) {}
    }, 150);
    return () => clearTimeout(t);
  }, [incoming?.channel_id]);

  if (!incoming) return null;

  const act = async (what: "answer_call" | "decline_call") => {
    setBusy(true);
    try {
      const res: any = await call(what, incoming.channel_id);
      if (res?.error) toaster.toast({ title: "Discordio", body: res.error });
      else setIncoming(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PanelSection title="Incoming call">
      <PanelSectionRow>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <Avatar src={incoming.caller?.avatar ?? null} size={40} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {incoming.caller?.name || "Someone"}
            </div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>{incoming.group ? `Group call · ${incoming.group}` : "is calling you"}</div>
            <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>{callHint()}</div>
          </div>
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        {/* Buttons directly inside Focusable (like the mute / deafen row) so
            the controller can move to them; wrapper divs made them unreachable. */}
        <div ref={answerRef}>
          <Focusable style={{ display: "flex", gap: "8px" }}>
            <ColorButton color="#23a55a" disabled={busy} onClick={() => act("answer_call")}>
              <FaPhone /> Answer
            </ColorButton>
            <ColorButton color="#da373c" disabled={busy} onClick={() => act("decline_call")}>
              <FaPhoneSlash /> Decline
            </ColorButton>
          </Focusable>
        </div>
      </PanelSectionRow>
    </PanelSection>
  );
}
