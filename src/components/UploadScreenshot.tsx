import { call, toaster } from "@decky/api";
import { ButtonItem, DialogButton, Focusable, PanelSectionRow } from "@decky/ui";
import { useEffect, useState } from "react";
import { Avatar } from "./VoiceChatViews";

type Friend = { id: string; name: string; avatar: string | null; status: string };
type Guild = { id: string; name: string; icon: string | null };
type Channel = { id: string; name: string };

// Steps: pick Friend or Server -> (server) pick a server -> pick a channel / friend -> sent.
type Step = { kind: "start" } | { kind: "friends" } | { kind: "servers" } | { kind: "channels"; guild: Guild };


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

export type Shot = { id: string; appid: number; time: number; thumb: string | null };

const gameName = (appid: number) => {
  try {
    return (window as any).appStore?.GetAppOverviewByAppID?.(appid)?.display_name || "";
  } catch (_) {
    return "";
  }
};

// Grid of recent screenshots from Steam's screenshot folders.
export function ShotGrid({ selected, onPick }: { selected: string | null; onPick: (s: Shot) => void }) {
  const [shots, setShots] = useState<Shot[] | null>(null);
  const [total, setTotal] = useState(0);
  const more = (offset: number) =>
    call<[number, number], { items: Shot[]; total: number }>("list_screenshots", offset, 12).then((r) => {
      setShots((old) => [...(offset ? old ?? [] : []), ...(r?.items ?? [])]);
      setTotal(r?.total ?? 0);
    });
  useEffect(() => {
    more(0);
  }, []);
  if (!shots) return <Hint>Loading screenshots...</Hint>;
  if (shots.length === 0) return <Hint>No screenshots found. Press Steam + R1 in a game to take one.</Hint>;
  return (
    <>
      <PanelSectionRow>
        <Focusable style={{ display: "flex", flexWrap: "wrap", gap: "6px" }} flow-children="row">
          {shots.map((sh) => (
            <DialogButton
              key={sh.id}
              onClick={() => onPick(sh)}
              style={{
                width: "calc(33% - 4px)", minWidth: 0, padding: 0, height: "54px", overflow: "hidden",
                border: sh.id === selected ? "2px solid #5865f2" : "2px solid transparent",
              }}
            >
              {sh.thumb ? (
                <img src={sh.thumb} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
              ) : (
                <span style={{ fontSize: 10 }}>{gameName(sh.appid) || "Screenshot"}</span>
              )}
            </DialogButton>
          ))}
        </Focusable>
      </PanelSectionRow>
      {shots.length < total && (
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => more(shots.length)}>
            Show more ({total - shots.length} left)
          </ButtonItem>
        </PanelSectionRow>
      )}
    </>
  );
}

export function UploadScreenshot() {
  const [shot, setShot] = useState<Shot | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [step, setStep] = useState<Step>({ kind: "start" });
  const [sending, setSending] = useState(false);

  // Start with the newest screenshot.
  useEffect(() => {
    call<[number, number], { items: Shot[] }>("list_screenshots", 0, 1).then((r) => r?.items?.[0] && setShot(r.items[0]));
  }, []);

  useEffect(() => {
    if (!shot) return;
    setPreview(shot.thumb);
    call<[string], { image?: string }>("get_screenshot", shot.id).then((r) => r?.image && setPreview(r.image));
  }, [shot?.id]);

  if (picking || !shot) {
    return (
      <>
        {shot && (
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => setPicking(false)}>
              ← Done
            </ButtonItem>
          </PanelSectionRow>
        )}
        <ShotGrid
          selected={shot?.id ?? null}
          onPick={(sh) => {
            setShot(sh);
            setPicking(false);
            setStep({ kind: "start" });
          }}
        />
      </>
    );
  }

  const send = async (label: string, target: { channelId?: string; userId?: string }) => {
    setSending(true);
    try {
      const res: any = await call("post_screenshot_file", shot.id, target.channelId ?? null, target.userId ?? null);
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

  const name = gameName(shot.appid);

  return (
    <>
      <PanelSectionRow>
        <div style={{ width: "100%" }}>
          {preview && <img src={preview} style={{ width: "100%", borderRadius: "6px", display: "block" }} />}
          <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>
            {name ? `${name} · ` : ""}
            {new Date(shot.time * 1000).toLocaleString()}
          </div>
        </div>
      </PanelSectionRow>

      {step.kind === "start" && (
        <>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => setPicking(true)}>
              Choose another screenshot
            </ButtonItem>
          </PanelSectionRow>
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
            Show Offline Friends Too
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
