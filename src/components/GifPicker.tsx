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

function GifGrid({ list, onPick }: { list: Gif[]; onPick: (g: Gif) => void }) {
  const [shown, setShown] = useState(PAGE);
  const rows: Gif[][] = [];
  const vis = list.slice(0, shown);
  for (let i = 0; i < vis.length; i += 2) rows.push(vis.slice(i, i + 2));
  return (
    <>
      {rows.map((row, r) => (
        <PanelSectionRow key={r}>
          <Focusable style={{ display: "flex", gap: 6 }} flow-children="row" navEntryPreferPosition={MAINTAIN_X as any}>
            {row.map((g) => (
              <DialogButton
                key={g.url + g.src}
                onClick={() => onPick(g)}
                style={{ flex: "0 0 calc(50% - 3px)", minWidth: 0, height: 84, padding: 0, overflow: "hidden" }}
              >
                {g.video ? (
                  <video src={g.src} autoPlay loop muted playsInline style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                ) : (
                  <img src={g.src} loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                )}
              </DialogButton>
            ))}
          </Focusable>
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

// Discord's GIF picker: favorites, trending and search. Picking one sends it.
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
        <Focusable style={{ display: "flex", gap: 6 }}>
          <DialogButton style={{ flex: 2, minWidth: 0 }} disabled={searching || !query.trim()} onClick={search}>
            {searching ? "Searching..." : "Search"}
          </DialogButton>
          {results && (
            <DialogButton style={{ flex: 2, minWidth: 0 }} onClick={() => { setResults(null); setQuery(""); }}>
              Clear
            </DialogButton>
          )}
          <DialogButton style={{ flex: 1, minWidth: 0 }} onClick={onClose}>
            Close
          </DialogButton>
        </Focusable>
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
          {!!home?.trending?.length && (
            <>
              <PanelSectionRow><div style={small}>Trending</div></PanelSectionRow>
              <GifGrid list={home.trending} onPick={onPick} />
            </>
          )}
        </>
      )}
    </>
  );
}
