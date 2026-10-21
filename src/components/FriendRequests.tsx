import { call, toaster } from "@decky/api";
import { ButtonItem, Focusable, PanelSectionRow, TextField } from "@decky/ui";
import { useEffect, useState } from "react";
import { FaCheck, FaTimes } from "react-icons/fa";
import { ColorButton } from "./ColorButton";
import { Avatar } from "./VoiceChatViews";

type Req = { id: string; name: string; username: string | null; avatar: string | null };
type Reqs = { incoming: Req[]; outgoing: Req[]; error?: string };

const small = { fontSize: "12px", opacity: 0.7 };

// Incoming and sent friend requests, and adding someone by username.
export function FriendRequests() {
  const [reqs, setReqs] = useState<Reqs | null>(null);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => call<[], Reqs>("get_friend_requests").then((r) => setReqs(r && !r.error ? r : { incoming: [], outgoing: [] })).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  const act = async (action: string, r: Req | null, done: string) => {
    setBusy(true);
    try {
      const res: any = await call("friend_request", action, r?.id ?? null, action === "send" ? name : null);
      toaster.toast({ title: "Discordio", body: res?.error ? `Couldn't do that: ${res.error}` : done });
      if (!res?.error && action === "send") setName("");
      load();
    } finally {
      setBusy(false);
    }
  };

  const incoming = reqs?.incoming ?? [];
  const outgoing = reqs?.outgoing ?? [];
  const count = incoming.length;

  return (
    <>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => setOpen(!open)}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            {open ? "▾" : "▸"} Friend Requests
            {count > 0 && (
              <span style={{ background: "#ed4245", color: "#fff", borderRadius: 8, fontSize: 10, padding: "0 6px", fontWeight: 700 }}>{count}</span>
            )}
          </span>
        </ButtonItem>
      </PanelSectionRow>
      {open && (
        <>
          {!incoming.length && !outgoing.length && (
            <PanelSectionRow>
              <div style={small}>No pending friend requests.</div>
            </PanelSectionRow>
          )}
          {incoming.map((r) => (
            <PanelSectionRow key={r.id}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
                <Avatar src={r.avatar} size={28} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</div>
                  <div style={{ fontSize: 11, opacity: 0.6 }}>wants to be friends</div>
                </div>
                <Focusable style={{ display: "flex", gap: 6, width: 104, flex: "none" }}>
                  <ColorButton color="#23a55a" disabled={busy} onClick={() => act("accept", r, `You're now friends with ${r.name}`)}>
                    <FaCheck />
                  </ColorButton>
                  <ColorButton color="#da373c" disabled={busy} onClick={() => act("decline", r, `Declined ${r.name}`)}>
                    <FaTimes />
                  </ColorButton>
                </Focusable>
              </div>
            </PanelSectionRow>
          ))}
          {outgoing.length > 0 && (
            <PanelSectionRow>
              <div style={{ ...small, marginTop: 6 }}>Sent</div>
            </PanelSectionRow>
          )}
          {outgoing.map((r) => (
            <PanelSectionRow key={r.id}>
              <ButtonItem layout="inline" label={<span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><Avatar src={r.avatar} size={24} />{r.name}</span>}
                disabled={busy} onClick={() => act("cancel", r, `Cancelled the request to ${r.name}`)}>
                Cancel
              </ButtonItem>
            </PanelSectionRow>
          ))}
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => setAdding(!adding)}>
              {adding ? "Close" : "Add Friend"}
            </ButtonItem>
          </PanelSectionRow>
          {adding && (
            <>
              <PanelSectionRow>
                <TextField label="Their Discord username" value={name} onChange={(e) => setName(e.target.value)} />
              </PanelSectionRow>
              <PanelSectionRow>
                <ButtonItem layout="below" disabled={busy || !name.trim()} onClick={() => act("send", null, `Friend request sent to ${name.trim()}`)}>
                  Send Friend Request
                </ButtonItem>
              </PanelSectionRow>
            </>
          )}
        </>
      )}
    </>
  );
}
