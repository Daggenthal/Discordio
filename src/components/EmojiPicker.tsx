import { call } from "@decky/api";
import { DialogButton, Focusable, PanelSectionRow } from "@decky/ui";
import { useEffect, useState } from "react";

export type Emoji = { id: string | null; name: string; animated?: boolean; url?: string | null; emoji?: string | null };
type Server = { id: string; name: string; icon: string | null; emojis: Emoji[] };
type EmojiList = { nitro?: boolean; recent: Emoji[]; favorites: Emoji[]; servers: Server[]; error?: string };

const QUICK: Emoji[] = ["👍", "❤️", "😂", "😮", "😢", "🔥"].map((e) => ({ id: null, name: e, emoji: e }));
const PER_ROW = 6;
const PAGE = 36;

// One fetch per conversation, reused for a few minutes.
const cache = new Map<string, { at: number; p: Promise<EmojiList> }>();
function loadEmojis(channelId: string) {
  const hit = cache.get(channelId);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.p;
  const p = call<[string], EmojiList>("get_emojis", channelId).then((r) => {
    if (!r || r.error) cache.delete(channelId);
    return r;
  });
  cache.set(channelId, { at: Date.now(), p });
  return p;
}

export const sameEmoji = (a: { id?: string | null; name?: string | null; emoji?: string | null }, b: Emoji) =>
  a.id ? a.id === b.id : (a.emoji ?? a.name) === (b.emoji ?? b.name);

const small = { fontSize: "11px", opacity: 0.7, margin: "4px 0 2px" };

function Rows({ list, onPick, mine }: { list: Emoji[]; onPick: (e: Emoji) => void; mine: (e: Emoji) => boolean }) {
  const rows: Emoji[][] = [];
  for (let i = 0; i < list.length; i += PER_ROW) rows.push(list.slice(i, i + PER_ROW));
  return (
    <>
      {rows.map((row, r) => (
        <PanelSectionRow key={r}>
          {/* One focus row per line, so up / down move between lines. */}
          <Focusable style={{ display: "flex", gap: 4 }} flow-children="row">
            {row.map((e) => (
              <DialogButton
                key={e.id || e.name}
                onClick={() => onPick(e)}
                style={{
                  minWidth: 0, width: 38, height: 36, padding: 0, fontSize: 18,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  border: mine(e) ? "2px solid #5865f2" : "2px solid transparent",
                }}
              >
                {e.url ? <img src={e.url} alt={e.name} style={{ width: 24, height: 24, objectFit: "contain" }} /> : e.emoji ?? e.name}
              </DialogButton>
            ))}
          </Focusable>
        </PanelSectionRow>
      ))}
    </>
  );
}

// Reaction picker under a message: what's already on it, your recent and
// favorite emojis, then every server's emojis you're allowed to use.
export function EmojiPicker({
  channelId,
  existing,
  onPick,
  onClose,
}: {
  channelId: string;
  existing: (Emoji & { me?: boolean })[];
  onPick: (e: Emoji, remove: boolean) => void;
  onClose: () => void;
}) {
  const [list, setList] = useState<EmojiList | null>(null);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);

  useEffect(() => {
    loadEmojis(channelId)
      .then(setList)
      .catch((e) => setList({ recent: [], favorites: [], servers: [], error: String(e) }));
  }, [channelId]);

  const mine = (e: Emoji) => existing.some((r) => r.me && sameEmoji(r, e));
  const pick = (e: Emoji) => onPick(e, mine(e));
  const recent = list?.recent?.length ? list.recent : QUICK;

  return (
    <>
      {!!existing.length && (
        <>
          <PanelSectionRow><div style={small}>On this message</div></PanelSectionRow>
          <Rows list={existing} onPick={pick} mine={mine} />
        </>
      )}
      <PanelSectionRow><div style={small}>{list?.recent?.length ? "Recently used" : "Quick reactions"}</div></PanelSectionRow>
      <Rows list={recent} onPick={pick} mine={mine} />
      {!!list?.favorites?.length && (
        <>
          <PanelSectionRow><div style={small}>Favorites</div></PanelSectionRow>
          <Rows list={list.favorites} onPick={pick} mine={mine} />
        </>
      )}
      {!list && <PanelSectionRow><div style={small}>Loading your emojis...</div></PanelSectionRow>}
      {list?.error && <PanelSectionRow><div style={{ ...small, color: "#ed4245" }}>Couldn't load your emojis: {list.error}</div></PanelSectionRow>}
      <PanelSectionRow>
        <Focusable style={{ display: "flex", gap: 6 }}>
          {!!list?.servers?.length && (
            <DialogButton style={{ flex: 2, minWidth: 0 }} onClick={() => setAll(!all)}>
              {all ? "Hide Server Emojis" : "Server Emojis"}
            </DialogButton>
          )}
          <DialogButton style={{ flex: 1, minWidth: 0 }} onClick={onClose}>
            Close
          </DialogButton>
        </Focusable>
      </PanelSectionRow>
      {all && list && !list.nitro && (
        <PanelSectionRow>
          <div style={small}>Without Nitro, a server's emojis only work in that server.</div>
        </PanelSectionRow>
      )}
      {all &&
        list?.servers.map((s) => (
          <div key={s.id}>
            <PanelSectionRow>
              <DialogButton
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", minWidth: 0 }}
                onClick={() => {
                  setOpen(open === s.id ? null : s.id);
                  setShown(PAGE);
                }}
              >
                {s.icon && <img src={s.icon} style={{ width: 20, height: 20, borderRadius: 6 }} />}
                <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {s.name}
                </span>
                <span style={{ opacity: 0.6, fontSize: 11 }}>
                  {s.emojis.length} {open === s.id ? "▴" : "▾"}
                </span>
              </DialogButton>
            </PanelSectionRow>
            {open === s.id && (
              <>
                <Rows list={s.emojis.slice(0, shown)} onPick={pick} mine={mine} />
                {s.emojis.length > shown && (
                  <PanelSectionRow>
                    <DialogButton onClick={() => setShown(shown + PAGE)}>Show More ({s.emojis.length - shown} left)</DialogButton>
                  </PanelSectionRow>
                )}
              </>
            )}
          </div>
        ))}
    </>
  );
}
