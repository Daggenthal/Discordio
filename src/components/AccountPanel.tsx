import { call, toaster } from "@decky/api";
import { ButtonItem, PanelSectionRow, Router } from "@decky/ui";
import { useEffect, useState } from "react";
import { Avatar } from "./VoiceChatViews";
import { fire } from "../lib/events";
import { useUiSettings } from "../lib/settings";

type Account = { id: string; name: string; avatar: string | null; current: boolean; valid: boolean };
type Accounts = { me: { id: string; name: string; avatar: string | null } | null; saved: Account[]; canSwitch: boolean; error?: string };

// Who you're logged in as, switching between the accounts Discord
// remembers, adding one, and logging out.
export function AccountPanel() {
  const ui = useUiSettings();
  const [a, setA] = useState<Accounts | null>(null);
  const [handle, setHandle] = useState<string | null>(null);
  useEffect(() => {
    call<[], any>("get_state").then((st) => setHandle(st?.me?.handle ?? null)).catch(() => {});
  }, []);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => call<[], Accounts>("get_accounts").then(setA).catch(() => {});
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 4000);
    return () => clearTimeout(t);
  }, [confirm]);

  if (!a) return null;
  if (a.error) {
    return (
      <PanelSectionRow>
        <div style={{ fontSize: 12, color: "#ff6b6b" }}>{a.error}</div>
      </PanelSectionRow>
    );
  }
  if (!a.me) {
    return (
      <PanelSectionRow>
        <ButtonItem layout="below" description="Not logged in" onClick={() => Router.Navigate("/discord")}>
          Open Discord to log in
        </ButtonItem>
      </PanelSectionRow>
    );
  }
  const others = (a.saved || []).filter((x) => !x.current);

  const act = async (fn: () => Promise<any>, done: string) => {
    setBusy(true);
    try {
      const res: any = await fn();
      toaster.toast({ title: "Discordio", body: res?.error ? res.error : done });
    } finally {
      setBusy(false);
      setTimeout(load, 3000);
    }
  };

  return (
    <>
      <PanelSectionRow>
        <div style={{ fontWeight: 700, fontSize: "13px", marginTop: "14px" }}>Account</div>
      </PanelSectionRow>
      {a.me && (
        <PanelSectionRow>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Avatar src={a.me.avatar} size={28} />
            <span>
              Current Account: <b>{a.me.name}</b>
            </span>
          </div>
        </PanelSectionRow>
      )}
      {handle && !ui.hideUsernames && (
        <PanelSectionRow>
          <div style={{ fontSize: 13, lineHeight: 1.4 }}>
            Your Username: <b style={{ fontSize: 15 }}>{handle}</b>
            <div style={{ fontSize: 11, opacity: 0.65 }}>Give this to someone so they can add you as a friend</div>
          </div>
        </PanelSectionRow>
      )}
      {others.map((x) => (
        <PanelSectionRow key={x.id}>
          <ButtonItem
            layout="below"
            disabled={busy || !a.canSwitch}
            onClick={() => act(() => call("switch_account", x.id), `Switching to ${x.name}...`)}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <Avatar src={x.avatar} size={24} />
              Switch Account: {x.name}
              {!x.valid && <span style={{ fontSize: 10, opacity: 0.7 }}>(needs logging in again)</span>}
            </span>
          </ButtonItem>
        </PanelSectionRow>
      ))}
      <PanelSectionRow>
        <ButtonItem
          layout="below"
          description="Opens Discord: select your avatar (bottom left), then Switch Accounts and Add an Account"
          onClick={() => Router.Navigate("/discord")}
        >
          Add Another Account
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem
          layout="below"
          disabled={busy}
          onClick={() => {
            if (!confirm) return setConfirm(true);
            setConfirm(false);
            act(async () => {
              const res: any = await call("logout");
              if (!res?.error) {
                // Close Settings and go to the top, where Open Discord is.
                fire("collapse-all");
                setTimeout(() => fire("jump:top"), 80);
              }
              return res;
            }, "Logged out. Open Discord to log in again");
          }}
        >
          <span style={{ color: "#ff6b6b" }}>{confirm ? "Press again to logout" : "Logout"}</span>
        </ButtonItem>
      </PanelSectionRow>
    </>
  );
}
