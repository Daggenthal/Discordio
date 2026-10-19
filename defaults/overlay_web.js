// Discordio overlay, "Steam layer" engine.
//
// Injected into one of Steam's own UI windows that is drawn over games, so it
// doesn't need gamescope's single external-overlay slot (which Steam's
// performance overlay / MangoHud uses). Same look and behaviour as the
// gamescope engine: speakers get a green ring, a small hop, and stay raised
// while talking; everyone else drops back and fades.
//
// Idempotent: running it again just updates settings. window.__discordioOverlayStop()
// removes it.
(() => {
    const STATE_URL = "http://127.0.0.1:65123/overlay";
    if (window.__discordioOverlay) return "already running";
    window.__discordioOverlay = true;

    const style = document.createElement("style");
    style.id = "discordio-overlay-style";
    style.textContent = `
      #discordio-overlay { position: fixed; z-index: 2147483647; pointer-events: none; width: 270px;
        background: rgba(18,18,20,0.62); border-radius: 10px; padding: 10px 10px 4px;
        font-family: "Motiva Sans", "Noto Sans", sans-serif; color: #fff; box-sizing: border-box;
        transition: opacity .2s; }
      #discordio-overlay[hidden] { display: none; }
      #discordio-overlay .dio-head { display: flex; align-items: flex-start; gap: 6px; margin-bottom: 6px; }
      #discordio-overlay .dio-titles { flex: 1; min-width: 0; }
      #discordio-overlay .dio-ch { font-weight: 700; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #discordio-overlay .dio-g { font-size: 11px; opacity: .6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #discordio-overlay .dio-row { display: flex; align-items: center; gap: 8px; height: 36px;
        opacity: .55; transform: translateY(0);
        transition: transform .22s cubic-bezier(.3,1.6,.5,1), opacity .25s; }
      #discordio-overlay .dio-row.speaking { opacity: 1; transform: translateY(-4px); }
      #discordio-overlay .dio-row.hop { animation: dio-hop .32s ease-out; }
      @keyframes dio-hop { 0% { transform: translateY(0); } 45% { transform: translateY(-10px); } 100% { transform: translateY(-4px); } }
      #discordio-overlay .dio-av { width: 28px; height: 28px; border-radius: 50%; background: #5865f2; flex-shrink: 0;
        object-fit: cover; box-shadow: 0 0 0 0 #23a55a; transition: box-shadow .15s; }
      #discordio-overlay .dio-row.speaking .dio-av { box-shadow: 0 0 0 2.5px #23a55a; }
      #discordio-overlay .dio-name { flex: 1; min-width: 0; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #discordio-overlay .dio-row.speaking .dio-name { font-weight: 700; }
      #discordio-overlay .dio-tag { font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 4px; flex-shrink: 0; }
      #discordio-overlay .dio-live { background: #ed4245; color: #fff; }
      #discordio-overlay .dio-deaf { border: 1.5px solid #ed4245; color: #ed4245; }
      #discordio-overlay .dio-mute { width: 14px; height: 14px; flex-shrink: 0; }
    `;
    document.head.appendChild(style);

    const root = document.createElement("div");
    root.id = "discordio-overlay";
    root.hidden = true;
    document.body.appendChild(root);

    const MIC_OFF = '<svg class="dio-mute" viewBox="0 0 24 24" fill="none" stroke="#ed4245" stroke-width="2.4" stroke-linecap="round">' +
        '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16"/></svg>';

    const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const rows = new Map(); // id -> row element
    let lastHead = "";

    const place = (pos) => {
        const m = "24px";
        root.style.top = pos.includes("top") ? m : "";
        root.style.bottom = pos.includes("bottom") ? m : "";
        root.style.left = pos.includes("left") ? m : "";
        root.style.right = pos.includes("right") ? m : "";
    };

    const render = (state) => {
        const settings = (state && state.settings) || {};
        const voice = state && state.voice;
        if (!voice || settings.overlay_enabled === false || settings.overlay_engine_active !== "steam") {
            root.hidden = true;
            return;
        }
        root.hidden = false;
        place(settings.overlay_position || "top-left");

        const me = state.me || {};
        const head = `<div class="dio-head"><div class="dio-titles"><div class="dio-ch">${esc(voice.channel_name)}</div>` +
            `<div class="dio-g">${esc(voice.guild_name)}</div></div>${me.live ? '<span class="dio-tag dio-live">LIVE</span>' : ""}</div>`;
        if (head !== lastHead) {
            let h = root.querySelector(".dio-head");
            if (h) h.outerHTML = head; else root.insertAdjacentHTML("afterbegin", head);
            lastHead = head;
        }

        const seen = new Set();
        for (const m of voice.members || []) {
            seen.add(m.id);
            let row = rows.get(m.id);
            if (!row) {
                row = document.createElement("div");
                row.className = "dio-row";
                row.innerHTML = '<img class="dio-av"><div class="dio-name"></div><span class="dio-status"></span>';
                rows.set(m.id, row);
            }
            root.appendChild(row); // keeps member order
            const img = row.querySelector(".dio-av");
            const src = m.avatar || "";
            if (img.getAttribute("src") !== src) { if (src) img.setAttribute("src", src); else img.removeAttribute("src"); }
            row.querySelector(".dio-name").textContent = m.name || "";
            const status = (m.live ? '<span class="dio-tag dio-live">LIVE</span>' : "") +
                (m.deafened ? '<span class="dio-tag dio-deaf">DEAF</span>' : m.muted ? MIC_OFF : "");
            const st = row.querySelector(".dio-status");
            if (st.innerHTML !== status) st.innerHTML = status;
            const was = row.classList.contains("speaking");
            row.classList.toggle("speaking", !!m.speaking);
            if (m.speaking && !was) {
                row.classList.remove("hop");
                void row.offsetWidth; // restart the animation
                row.classList.add("hop");
            }
        }
        for (const [id, row] of rows) {
            if (!seen.has(id)) { row.remove(); rows.delete(id); }
        }
    };

    let stopped = false, busy = false;
    const timer = setInterval(async () => {
        if (busy || stopped) return;
        busy = true;
        try {
            const r = await fetch(STATE_URL, { cache: "no-store" });
            render(r.ok ? await r.json() : null);
        } catch (_) {
            render(null);
        } finally {
            busy = false;
        }
    }, 120);

    window.__discordioOverlayStop = () => {
        stopped = true;
        clearInterval(timer);
        root.remove();
        style.remove();
        delete window.__discordioOverlay;
        delete window.__discordioOverlayStop;
        return "stopped";
    };
    return "started";
})()
