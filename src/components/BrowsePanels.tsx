import { call, toaster } from "@decky/api";
import { ButtonItem, DropdownItem, PanelSectionRow, ToggleField } from "@decky/ui";
import { useEffect, useState } from "react";
import { Avatar, MemberRow, Member } from "./VoiceChatViews";

type Guild = { id: string; name: string; icon: string | null };
type VoiceChannel = { id: string; name: string; members: Member[] };
type Friend = { id: string; name: string; avatar: string | null; status: string };

const KEY_GUILD = "DISCORDIO_LAST_GUILD";

const query = async <T,>(what: string, arg?: string): Promise<T | null> => {
  try {
    const res: any = await call("discord_query", what, arg ?? null);
    if (!res || res.error) {
      if (res?.error) console.warn("[Discordio] query", what, res.error);
      return null;
    }
    return res as T;
  } catch (_) {
    return null;
  }
};

const report = (res: any, ok: string) => {
  toaster.toast({ title: "Discordio", body: res && res.error ? res.error : ok });
};

export function ServersPanel() {
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [guild, setGuild] = useState<string | null>(() => {
    try {
      return localStorage.getItem(KEY_GUILD);
    } catch (_) {
      return null;
    }
  });
  const [channels, setChannels] = useState<VoiceChannel[]>([]);

  useEffect(() => {
    query<Guild[]>("guilds").then((g) => Array.isArray(g) && setGuilds(g));
  }, []);

  useEffect(() => {
    if (!guild) return;
    let alive = true;
    const load = () => query<VoiceChannel[]>("voice_channels", guild).then(
      (c) => alive && Array.isArray(c) && setChannels(c.map((ch) => ({ ...ch, members: Array.isArray(ch.members) ? ch.members : [] })))
    );
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [guild]);

  return (
    <>
      <PanelSectionRow>
        <DropdownItem
          label="Server"
          strDefaultLabel={guilds.length ? "Pick a server" : "Loading servers..."}
          rgOptions={guilds.map((g) => ({ data: g.id, label: g.name }))}
          selectedOption={guild}
          onChange={(o) => {
            setGuild(o.data);
            setChannels([]);
            try {
              localStorage.setItem(KEY_GUILD, o.data);
            } catch (_) {}
          }}
        />
      </PanelSectionRow>
      {guild && channels.length === 0 && (
        <PanelSectionRow>
          <div style={{ fontSize: "12px", opacity: 0.7 }}>No voice channels you can see here</div>
        </PanelSectionRow>
      )}
      {channels.map((ch) => (
        <PanelSectionRow key={ch.id}>
          <ButtonItem
            layout="below"
            label={`🔊 ${ch.name}`}
            description={ch.members.length ? `${ch.members.length} in channel` : "Empty"}
            onClick={async () => report(await call("join_voice", ch.id), `Joining ${ch.name}`)}
          >
            Join
          </ButtonItem>
          {ch.members.length > 0 && (
            <div style={{ paddingLeft: "8px", paddingBottom: "6px" }}>
              {ch.members.map((m) => (
                <MemberRow key={m.id} m={m} />
              ))}
            </div>
          )}
        </PanelSectionRow>
      ))}
    </>
  );
}

const STATUS_COLOR: Record<string, string> = {
  online: "#23a55a",
  idle: "#f0b232",
  dnd: "#f23f43",
  offline: "#80848e",
};

export function FriendsPanel() {
  const [friends, setFriends] = useState<Friend[] | null>(null);
  const [showOffline, setShowOffline] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => query<Friend[]>("friends").then((f) => alive && Array.isArray(f) && setFriends(f));
    load();
    const t = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!friends) {
    return (
      <PanelSectionRow>
        <div style={{ fontSize: "12px", opacity: 0.7 }}>Loading friends...</div>
      </PanelSectionRow>
    );
  }

  const list = friends.filter((f) => showOffline || f.status !== "offline").slice(0, 60);

  return (
    <>
      <PanelSectionRow>
        <ToggleField label="Show offline friends" checked={showOffline} onChange={setShowOffline} />
      </PanelSectionRow>
      {list.length === 0 && (
        <PanelSectionRow>
          <div style={{ fontSize: "12px", opacity: 0.7 }}>Nobody online right now</div>
        </PanelSectionRow>
      )}
      {list.map((f) => (
        <PanelSectionRow key={f.id}>
          <ButtonItem
            layout="inline"
            label={
              <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                <span style={{ position: "relative", display: "inline-block" }}>
                  <Avatar src={f.avatar} size={28} />
                  <span
                    style={{
                      position: "absolute", right: -1, bottom: -1, width: 10, height: 10, borderRadius: "50%",
                      background: STATUS_COLOR[f.status] || STATUS_COLOR.offline, border: "2px solid #23262e",
                    }}
                  />
                </span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
              </span>
            }
            onClick={async () => report(await call("call_friend", f.id), `Calling ${f.name}`)}
          >
            Call
          </ButtonItem>
        </PanelSectionRow>
      ))}
    </>
  );
}
