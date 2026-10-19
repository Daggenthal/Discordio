import { addEventListener, call, removeEventListener, toaster } from "@decky/api";
import { DialogButton, Focusable, Navigation, PanelSection, PanelSectionRow } from "@decky/ui";
import { useEffect, useRef, useState } from "react";
import { FaPhone, FaPhoneSlash } from "react-icons/fa";
import { Avatar } from "./VoiceChatViews";

type Incoming = {
  channel_id: string;
  caller: { id: string | null; name: string; avatar: string | null };
  group?: string | null;
} | null;

// Steam notification when a call comes in; selecting it opens Discordio's
// panel, where the Answer / Decline buttons are. Registered once at load.
export function startCallNotifications() {
  const onCall = (c: any) => {
    if (!c?.ringing) return;
    const caller = c.caller || {};
    toaster.toast({
      title: `${caller.name || "Someone"} is calling`,
      body: c.group ? `${c.group}: open Discordio to answer` : "Open Discordio in the Quick Access Menu to answer",
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
  return () => removeEventListener("call", onCall);
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
          </div>
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <Focusable style={{ display: "flex", gap: 8 }} flow-children="row">
          <div ref={answerRef} style={{ flex: 1 }}>
            <DialogButton
              disabled={busy}
              onClick={() => act("answer_call")}
              style={{ background: "#23a55a", color: "#fff", minWidth: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
            >
              <FaPhone /> Answer
            </DialogButton>
          </div>
          <div style={{ flex: 1 }}>
            <DialogButton
              disabled={busy}
              onClick={() => act("decline_call")}
              style={{ background: "#da373c", color: "#fff", minWidth: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
            >
              <FaPhoneSlash /> Decline
            </DialogButton>
          </div>
        </Focusable>
      </PanelSectionRow>
    </PanelSection>
  );
}
