import { call, toaster } from "@decky/api";
import { ButtonItem, DialogButton, Focusable, PanelSectionRow, TextField, ToggleField } from "@decky/ui";
import { FaComment, FaPhone } from "react-icons/fa";
import { openConversationWith } from "./MessagesPanel";
import { useEffect, useState } from "react";
import { ColorButton } from "./ColorButton";
import { Avatar, MemberRow, Member } from "./VoiceChatViews";
import { fire } from "../lib/events";

type Guild = { id: string; name: string; icon: string | null };
type VoiceChannel = { id: string; name: string; members: Member[] };
type Friend = { id: string; name: string; avatar: string | null; status: string };

const KEY_GUILD = "DISCORDIO_LAST_GUILD";

type Result<T> = { data: T | null; error: string | null };

const query = async <T,>(what: string, arg?: string): Promise<Result<T>> => {
  try {
    const res: any = await call("discord_query", what, arg ?? null);
    if (res && res.error) return { data: null, error: String(res.error) };
    return { data: res as T, error: null };
  } catch (e) {
    return { data: null, error: String(e) };
  }
};

const report = (res: any, ok: string) => {
  toaster.toast({ title: "Discordio", body: res && res.error ? res.error : ok });
};

const Hint = ({ children, error }: { children: any; error?: boolean }) => (
  <PanelSectionRow>
    <div style={{ fontSize: "12px", opacity: error ? 1 : 0.7, color: error ? "#ff6b6b" : undefined, wordBreak: "break-word" }}>
      {children}
    </div>
  </PanelSectionRow>
);

// Voice channels of one server, with who's in each and a Join button.
function GuildChannels({ guildId }: { guildId: string }) {
  const [channels, setChannels] = useState<VoiceChannel[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      query<VoiceChannel[]>("voice_channels", guildId).then(({ data, error }) => {
        if (!alive) return;
        setError(error);
        if (Array.isArray(data)) {
          setChannels(data.map((ch) => ({ ...ch, members: Array.isArray(ch.members) ? ch.members : [] })));
        }
      });
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [guildId]);

  if (error) return <Hint error>{error}</Hint>;
  if (!channels) return <Hint>Loading voice channels...</Hint>;
  if (!channels.length) return <Hint>No voice channels you can see here</Hint>;

  return (
    <>
      {channels.map((ch) => (
        <PanelSectionRow key={ch.id}>
          <ButtonItem
            layout="inline"
            label={`🔊 ${ch.name}`}
            description={ch.members.length ? `${ch.members.length} in channel` : "Empty"}
            onClick={async () => {
              const res: any = await call("join_voice", ch.id);
              report(res, `Joining ${ch.name}`);
              if (!res?.error) fire("collapse:Servers");
            }}
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

export function ServersPanel() {
  const [guilds, setGuilds] = useState<Guild[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(() => {
    try {
      return localStorage.getItem(KEY_GUILD);
    } catch (_) {
      return null;
    }
  });

  const load = () =>
    query<Guild[]>("guilds").then(({ data, error }) => {
      setError(error);
      if (Array.isArray(data)) setGuilds(data);
    });

  useEffect(() => {
    load();
  }, []);

  if (error) {
    return (
      <>
        <Hint error>{error}</Hint>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={load}>Try again</ButtonItem>
        </PanelSectionRow>
      </>
    );
  }
  if (!guilds) return <Hint>Loading servers...</Hint>;
  if (!guilds.length) return <Hint>You're not in any servers</Hint>;

  return (
    <>
      {guilds.map((g) => (
        <div key={g.id}>
          <PanelSectionRow>
            <ButtonItem
              layout="inline"
              label={
                <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                  <Avatar src={g.icon} size={28} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.name}</span>
                </span>
              }
              onClick={() => {
                const next = open === g.id ? null : g.id;
                setOpen(next);
                try {
                  if (next) localStorage.setItem(KEY_GUILD, next);
                } catch (_) {}
              }}
            >
              {open === g.id ? "Hide" : "Voice"}
            </ButtonItem>
          </PanelSectionRow>
          {open === g.id && <GuildChannels guildId={g.id} />}
        </div>
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

const PAGE = 25;

export function FriendsPanel() {
  const [friends, setFriends] = useState<Friend[] | null>(null);
  const [showOffline, setShowOffline] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState(PAGE);

  useEffect(() => {
    let alive = true;
    const load = () =>
      query<Friend[]>("friends").then(({ data }) => alive && Array.isArray(data) && setFriends(data));
    load();
    const t = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  useEffect(() => setShown(PAGE), [search, showOffline]);

  if (!friends) {
    return (
      <PanelSectionRow>
        <div style={{ fontSize: "12px", opacity: 0.7 }}>Loading friends...</div>
      </PanelSectionRow>
    );
  }

  const q = search.trim().toLowerCase();
  // Searching looks through everyone, offline included.
  const matching = friends.filter((f) => (q ? f.name.toLowerCase().includes(q) : showOffline || f.status !== "offline"));
  const list = matching.slice(0, shown);
  const online = friends.filter((f) => f.status !== "offline").length;

  return (
    <>
      <PanelSectionRow>
        <div style={{ fontSize: 12, opacity: 0.7 }}>
          {online} online · {friends.length} friends
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        {/* Selecting the field with A opens Steam's keyboard. */}
        <TextField label="Find a friend" value={search} onChange={(e) => setSearch(e.target.value)} />
      </PanelSectionRow>
      {!q && (
        <PanelSectionRow>
          <ToggleField label="Show offline friends" checked={showOffline} onChange={setShowOffline} />
        </PanelSectionRow>
      )}
      {list.length === 0 && (
        <PanelSectionRow>
          <div style={{ fontSize: "12px", opacity: 0.7 }}>{q ? `Nobody matching "${search}"` : "Nobody online right now"}</div>
        </PanelSectionRow>
      )}
      {/* Its own scrolling area, so a long list doesn't push everything else
          down; moving through it with the controller scrolls it. */}
      <div style={{ maxHeight: 420, overflowY: "auto", overflowX: "hidden" }}>
        <Focusable>
          {list.map((f) => (
            <FriendRow key={f.id} f={f} open={openId === f.id} onToggle={() => setOpenId(openId === f.id ? null : f.id)} />
          ))}
          {matching.length > list.length && (
            <PanelSectionRow>
              <ButtonItem layout="below" onClick={() => setShown(shown + PAGE)}>
                Show more ({matching.length - list.length} more)
              </ButtonItem>
            </PanelSectionRow>
          )}
        </Focusable>
      </div>
    </>
  );
}

const callFriend = async (f: Friend) => {
  const res: any = await call("call_friend", f.id);
  report(res, `Calling ${f.name}`);
  if (!res?.error) fire("collapse:Friends");
};
const messageFriend = (f: Friend) => {
  fire("collapse:Friends");
  openConversationWith(f);
};

// A friend: A shows Call / Message, X calls, Options opens your messages.
function FriendRow({ f, open, onToggle }: { f: Friend; open: boolean; onToggle: () => void }) {
  return (
    <>
      <PanelSectionRow>
        <Focusable
          onOptionsButton={() => messageFriend(f)}
          onOptionsActionDescription="Message"
          onSecondaryButton={() => callFriend(f)}
          onSecondaryActionDescription="Call"
        >
          <ButtonItem
            layout="below"
            onClick={onToggle}
          >
            <span style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0, textAlign: "left" }}>
              <span style={{ position: "relative", display: "inline-block", flex: "none" }}>
                <Avatar src={f.avatar} size={28} />
                <span
                  style={{
                    position: "absolute", right: -1, bottom: -1, width: 10, height: 10, borderRadius: "50%",
                    background: STATUS_COLOR[f.status] || STATUS_COLOR.offline, border: "2px solid #23262e",
                  }}
                />
              </span>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
              <span style={{ opacity: 0.5, fontSize: 18 }}>{open ? "▾" : "▸"}</span>
            </span>
          </ButtonItem>
        </Focusable>
      </PanelSectionRow>
      {open && (
        <PanelSectionRow>
          <Focusable style={{ display: "flex", gap: "8px" }}>
            <ColorButton color="#23a55a" onClick={() => callFriend(f)}>
              <FaPhone /> Call
            </ColorButton>
            <DialogButton
              style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
              onClick={() => messageFriend(f)}
            >
              <FaComment /> Message
            </DialogButton>
          </Focusable>
        </PanelSectionRow>
      )}
    </>
  );
}
