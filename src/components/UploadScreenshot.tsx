import { call, toaster } from "@decky/api";
import { ButtonItem, PanelSectionRow } from "@decky/ui";
import { useEffect, useState } from "react";
import { Avatar } from "./VoiceChatViews";

type Friend = { id: string; name: string; avatar: string | null; status: string };
type Guild = { id: string; name: string; icon: string | null };
type Channel = { id: string; name: string };

// Steps: pick Friend or Server -> (server) pick a server -> pick a channel / friend -> sent.
type Step = { kind: "start" } | { kind: "friends" } | { kind: "servers" } | { kind: "channels"; guild: Guild };

const toDataUrl = async (url: string) => {
  const blob = await (await fetch(url)).blob();
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
};

const Hint = ({ children }: { children: any }) => (
  <PanelSectionRow>
    <div style={{ fontSize: "12px", opacity: 0.7 }}>{children}</div>
  </PanelSectionRow>
);

const row = (icon: string | null, text: string) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
    <Avatar src={icon} size={26} />
    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text}</span>
  </span>
);

function useList<T>(what: string, arg?: string) {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setItems(null);
    call<[string, string | null], any>("discord_query", what, arg ?? null)
      .then((r) => (Array.isArray(r) ? setItems(r) : setError(r?.error || "couldn't load")))
      .catch((e) => setError(String(e)));
  }, [what, arg]);
  return { items, error };
}

export function UploadScreenshot() {
  const [shot, setShot] = useState<string | null>(null);
  const [step, setStep] = useState<Step>({ kind: "start" });
  const [sending, setSending] = useState(false);

  useEffect(() => {
    try {
      SteamClient.Screenshots.GetLastScreenshotTaken().then((r: any) => r?.strUrl && setShot(`https://steamloopback.host/${r.strUrl}`));
    } catch (_) {}
  }, []);

  if (!shot) return <Hint>Take a Steam screenshot to share it here.</Hint>;

  const send = async (label: string, target: { channelId?: string; userId?: string }) => {
    setSending(true);
    try {
      const res: any = await call("post_screenshot", target.channelId ?? null, await toDataUrl(shot), target.userId ?? null);
      toaster.toast({ title: "Discordio", body: res?.error ? `Not sent: ${res.error}` : `Screenshot sent to ${label}` });
      if (!res?.error) setStep({ kind: "start" });
    } catch (e) {
      toaster.toast({ title: "Discordio", body: `Not sent: ${e}` });
    } finally {
      setSending(false);
    }
  };

  const back = (to: Step, label = "Back") => (
    <PanelSectionRow>
      <ButtonItem layout="below" onClick={() => setStep(to)}>
        ← {label}
      </ButtonItem>
    </PanelSectionRow>
  );

  return (
    <>
      <PanelSectionRow>
        <img src={shot} style={{ width: "100%", borderRadius: "6px", display: "block" }} />
      </PanelSectionRow>

      {step.kind === "start" && (
        <>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => setStep({ kind: "friends" })}>
              Send to a friend
            </ButtonItem>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => setStep({ kind: "servers" })}>
              Send to a server
            </ButtonItem>
          </PanelSectionRow>
        </>
      )}

      {step.kind === "friends" && (
        <>
          {back({ kind: "start" })}
          <FriendPicker disabled={sending} onPick={(f) => send(f.name, { userId: f.id })} />
        </>
      )}

      {step.kind === "servers" && (
        <>
          {back({ kind: "start" })}
          <ServerPicker onPick={(g) => setStep({ kind: "channels", guild: g })} />
        </>
      )}

      {step.kind === "channels" && (
        <>
          {back({ kind: "servers" }, "Other servers")}
          <ChannelPicker guild={step.guild} disabled={sending} onPick={(c) => send(`#${c.name}`, { channelId: c.id })} />
        </>
      )}
    </>
  );
}

function FriendPicker({ onPick, disabled }: { onPick: (f: Friend) => void; disabled: boolean }) {
  const { items, error } = useList<Friend>("friends");
  const [all, setAll] = useState(false);
  if (error) return <Hint>{error}</Hint>;
  if (!items) return <Hint>Loading friends...</Hint>;
  const online = items.filter((f) => f.status !== "offline");
  const list = all ? items : online;
  return (
    <>
      {list.length === 0 && <Hint>No friends online right now.</Hint>}
      {list.slice(0, 50).map((f) => (
        <PanelSectionRow key={f.id}>
          <ButtonItem layout="inline" disabled={disabled} label={row(f.avatar, f.name)} onClick={() => onPick(f)}>
            Send
          </ButtonItem>
        </PanelSectionRow>
      ))}
      {!all && items.length > online.length && (
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => setAll(true)}>
            Show offline friends too
          </ButtonItem>
        </PanelSectionRow>
      )}
    </>
  );
}

function ServerPicker({ onPick }: { onPick: (g: Guild) => void }) {
  const { items, error } = useList<Guild>("guilds");
  if (error) return <Hint>{error}</Hint>;
  if (!items) return <Hint>Loading servers...</Hint>;
  return (
    <>
      {items.map((g) => (
        <PanelSectionRow key={g.id}>
          <ButtonItem layout="inline" label={row(g.icon, g.name)} onClick={() => onPick(g)}>
            Pick
          </ButtonItem>
        </PanelSectionRow>
      ))}
    </>
  );
}

function ChannelPicker({ guild, onPick, disabled }: { guild: Guild; onPick: (c: Channel) => void; disabled: boolean }) {
  const { items, error } = useList<Channel>("text_channels", guild.id);
  if (error) return <Hint>{error}</Hint>;
  if (!items) return <Hint>Loading channels...</Hint>;
  return (
    <>
      <Hint>{guild.name}</Hint>
      {items.length === 0 && <Hint>No text channels you can post in.</Hint>}
      {items.map((c) => (
        <PanelSectionRow key={c.id}>
          <ButtonItem layout="inline" disabled={disabled} label={`# ${c.name}`} onClick={() => onPick(c)}>
            Send
          </ButtonItem>
        </PanelSectionRow>
      ))}
    </>
  );
}
