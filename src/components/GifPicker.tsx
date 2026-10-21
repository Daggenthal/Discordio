import { call } from "@decky/api";
import { DialogButton, Focusable, PanelSectionRow, TextField } from "@decky/ui";
import { useEffect, useState } from "react";

type Gif = { url: string; src: string; width?: number; height?: number; video?: boolean };
type Gifs = { favorites?: Gif[]; trending?: Gif[]; gifs?: Gif[]; error?: string };

const small = { fontSize: "11px", opacity: 0.7, margin: "4px 0 2px" };
const PAGE = 12;

// Entering a row keeps the same column (Steam otherwise jumps back to
// whatever was last focused in that row, which looked like a diagonal move).
const MAINTAIN_X = 2;

// The picture fills the whole button, which hid Steam's focus highlight:
// draw our own ring so you can see which GIF is selected.
function GifTile({ g, onPick }: { g: Gif; onPick: (g: Gif) => void }) {
  const [focused, setFocused] = useState(false);
  const fill = { width: "100%", height: "100%", objectFit: "cover", display: "block", borderRadius: 4 } as const;
  return (
    <DialogButton
      onClick={() => onPick(g)}
      onOKActionDescription="Send"
      {...({ onGamepadFocus: () => setFocused(true), onGamepadBlur: () => setFocused(false) } as any)}
      style={{
        flex: "0 0 calc(50% - 3px)", minWidth: 0, height: 84, padding: 3, overflow: "hidden", boxSizing: "border-box",
        background: focused ? "#ffffff" : "rgba(255,255,255,0.08)",
        boxShadow: focused ? "0 0 0 2px #ffffff, 0 0 12px rgba(255,255,255,0.6)" : "none",
        transform: focused ? "scale(1.03)" : "none",
        transition: "transform 80ms, box-shadow 80ms",
      }}
    >
      {g.video ? (
        <video src={g.src} autoPlay loop muted playsInline style={{ ...fill, pointerEvents: "none" }} />
      ) : (
        <img src={g.src} loading="lazy" style={{ ...fill, pointerEvents: "none" }} />
      )}
    </DialogButton>
  );
}

function GifGrid({ list, onPick }: { list: Gif[]; onPick: (g: Gif) => void }) {
  const [shown, setShown] = useState(PAGE);
  const rows: Gif[][] = [];
  const vis = list.slice(0, shown);
  for (let i = 0; i < vis.length; i += 2) rows.push(vis.slice(i, i + 2));
  return (
    <>
      {rows.map((row, r) => (
        <PanelSectionRow key={r}>
          <div style={{ padding: "3px 0" }}><Focusable style={{ display: "flex", gap: 6 }} flow-children="row" navEntryPreferPosition={MAINTAIN_X as any}>
            {row.map((g) => (
              <GifTile key={g.url + g.src} g={g} onPick={onPick} />
            ))}
          </Focusable></div>
        </PanelSectionRow>
      ))}
      {list.length > shown && (
        <PanelSectionRow>
          <DialogButton onClick={() => setShown(shown + PAGE)}>Show More ({list.length - shown} left)</DialogButton>
        </PanelSectionRow>
      )}
    </>
  );
}

// Discord's GIF picker: your favorites, and search. Picking one sends it.
export function GifPicker({ onPick, onClose }: { onPick: (g: Gif) => void; onClose: () => void }) {
  const [home, setHome] = useState<Gifs | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Gifs | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    call<[], Gifs>("get_gifs")
      .then(setHome)
      .catch((e) => setHome({ error: String(e) }));
  }, []);

  const search = async () => {
    if (!query.trim()) return setResults(null);
    setSearching(true);
    try {
      setResults(await call<[string], Gifs>("get_gifs", query));
    } catch (e) {
      setResults({ error: String(e) });
    } finally {
      setSearching(false);
    }
  };

  return (
    <>
      <PanelSectionRow>
        <TextField
          label="Search Tenor"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e: any) => e.key === "Enter" && search()}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <div style={{ padding: "6px 0" }}><Focusable style={{ display: "flex", gap: 6 }}>
          <DialogButton style={{ flex: 2, minWidth: 0, height: "auto", minHeight: 44, lineHeight: 1.25 }} disabled={searching || !query.trim()} onClick={search}>
            {searching ? "Searching..." : "Search"}
          </DialogButton>
          {results && (
            <DialogButton style={{ flex: 2, minWidth: 0, height: "auto", minHeight: 44, lineHeight: 1.25 }} onClick={() => { setResults(null); setQuery(""); }}>
              Clear
            </DialogButton>
          )}
          <DialogButton style={{ flex: 1, minWidth: 0, height: "auto", minHeight: 44, lineHeight: 1.25 }} onClick={onClose}>
            Close
          </DialogButton>
        </Focusable></div>
      </PanelSectionRow>
      {results ? (
        <>
          {results.error && <PanelSectionRow><div style={{ ...small, color: "#ed4245" }}>Search failed: {results.error}</div></PanelSectionRow>}
          {!results.error && !results.gifs?.length && <PanelSectionRow><div style={small}>No GIFs found.</div></PanelSectionRow>}
          <GifGrid list={results.gifs || []} onPick={onPick} />
        </>
      ) : (
        <>
          {!home && <PanelSectionRow><div style={small}>Loading GIFs...</div></PanelSectionRow>}
          {home?.error && <PanelSectionRow><div style={{ ...small, color: "#ed4245" }}>Couldn't load GIFs: {home.error}</div></PanelSectionRow>}
          {!!home?.favorites?.length && (
            <>
              <PanelSectionRow><div style={small}>Favorites</div></PanelSectionRow>
              <GifGrid list={home.favorites} onPick={onPick} />
            </>
          )}
          {home && !home.error && !home.favorites?.length && (
            <PanelSectionRow>
              <div style={small}>No favorite GIFs yet. Star GIFs in Discord to see them here, or search above.</div>
            </PanelSectionRow>
          )}
        </>
      )}
      {/* Close from the bottom too, without scrolling back up. */}
      <PanelSectionRow>
        <DialogButton onClick={onClose}>Close GIFs</DialogButton>
      </PanelSectionRow>
    </>
  );
}
