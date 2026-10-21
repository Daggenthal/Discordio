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
      #discordio-messages { position: fixed; z-index: 2147483647; pointer-events: none; width: 320px;
        display: flex; flex-direction: column; gap: 8px; font-family: "Motiva Sans", "Noto Sans", sans-serif; }
      #discordio-messages .dio-msg { display: flex; gap: 10px; padding: 10px 12px; border-radius: 10px; color: #fff;
        background: rgba(18,18,20,0.82); box-shadow: 0 4px 16px rgba(0,0,0,.4); border-left: 3px solid #5865f2;
        animation: dio-in .25s ease-out; transition: opacity .4s, transform .4s; }
      #discordio-messages .dio-msg.leaving { opacity: 0; transform: translateX(-12px); }
      #discordio-messages .dio-msg.dio-call { border-left-color: #23a55a; animation: dio-in .25s ease-out, dio-ring 1s ease-in-out infinite; }
      @keyframes dio-ring { 0%, 100% { box-shadow: 0 4px 16px rgba(0,0,0,.4); } 50% { box-shadow: 0 0 0 3px rgba(35,165,90,.55), 0 4px 16px rgba(0,0,0,.4); } }
      @keyframes dio-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
      #discordio-messages .dio-msg img { width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0; background: #5865f2; object-fit: cover; }
      #discordio-messages .dio-msg-body { min-width: 0; flex: 1; }
      #discordio-messages .dio-msg-name { font-weight: 700; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #discordio-messages .dio-msg-ctx { font-size: 11px; opacity: .6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #discordio-messages .dio-msg-text { font-size: 13px; line-height: 17px; margin-top: 2px; opacity: .95;
        display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
      #discordio-messages .dio-msg-hint { font-size: 10px; opacity: .5; margin-top: 4px; }
    `;
    document.head.appendChild(style);

    const root = document.createElement("div");
    root.id = "discordio-overlay";
    root.hidden = true;
    document.body.appendChild(root);
    const msgRoot = document.createElement("div");
    msgRoot.id = "discordio-messages";
    document.body.appendChild(msgRoot);
    const cards = new Map();
    // Stream picture-in-picture.
    const pipRoot = document.createElement("div");
    pipRoot.id = "discordio-pip";
    pipRoot.hidden = true;
    pipRoot.style.cssText = "position:fixed;z-index:2147483647;border-radius:10px;overflow:hidden;pointer-events:none;box-shadow:0 4px 18px rgba(0,0,0,.5)";
    pipRoot.innerHTML = '<img style="display:block;width:100%"><div style="position:absolute;left:8px;bottom:8px;display:flex;gap:6px;align-items:center;font:700 12px sans-serif;color:#fff;text-shadow:0 1px 2px #000"><span style="background:#ed4245;border-radius:4px;padding:1px 5px;font-size:10px">LIVE</span><span class="dio-pip-name"></span></div>';
    document.body.appendChild(pipRoot);
    let pipSeq = null; // X-Seq of the frame on screen

    const MIC_OFF = '<svg class="dio-mute" viewBox="0 0 24 24" fill="none" stroke="#ed4245" stroke-width="2.4" stroke-linecap="round">' +
        '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16"/></svg>';

    const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const rows = new Map(); // id -> row element
    let lastHead = "";

    const place = (el, pos, offset = 0) => {
        const m = 24 + offset + "px";
        el.style.top = pos.includes("top") ? m : "";
        el.style.bottom = pos.includes("bottom") ? m : "";
        el.style.left = pos.includes("left") ? "24px" : "";
        el.style.right = pos.includes("right") ? "24px" : "";
    };

    // Message popups: DMs and mentions, newest at the edge of the screen.
    const renderMessages = (state) => {
        const settings = (state && state.settings) || {};
        const list = (state && state.messages) || [];
        const active = settings.overlay_engine_active === "steam";
        const pos = settings.message_position || "top-left";
        // Same corner as the voice panel: stack below / above it.
        const share = !root.hidden && pos === (settings.overlay_position || "top-left");
        place(msgRoot, pos, share ? root.offsetHeight + 10 : 0);
        msgRoot.style.flexDirection = pos.includes("bottom") ? "column-reverse" : "column";
        const seen = new Set();
        for (const m of active ? list : []) {
            seen.add(m.id);
            if (cards.has(m.id)) continue;
            const card = document.createElement("div");
            card.className = "dio-msg" + (m.kind === "call" ? " dio-call" : "");
            card.innerHTML = `${m.avatar ? `<img src="${esc(m.avatar)}">` : "<img>"}<div class="dio-msg-body">` +
                `<div class="dio-msg-name">${esc(m.name)}</div>` +
                (m.context ? `<div class="dio-msg-ctx">${esc(m.context)}</div>` : "") +
                `<div class="dio-msg-text">${esc(m.text)}</div>` +
                `<div class="dio-msg-hint">${esc(m.hint || "Reply from Discordio in the Quick Access Menu")}</div></div>`;
            msgRoot.prepend(card);
            cards.set(m.id, card);
        }
        for (const [id, card] of cards) {
            if (seen.has(id)) continue;
            cards.delete(id);
            card.classList.add("leaving");
            setTimeout(() => card.remove(), 400);
        }
    };

    const PIP_W = { small: 280, normal: 380, large: 520 };
    const renderPip = (state) => {
        const settings = (state && state.settings) || {};
        const pip = state && state.pip;
        if (!pip || settings.overlay_engine_active !== "steam") {
            pipRoot.hidden = true;
            pipSeq = null;
            return;
        }
        pipRoot.hidden = false;
        // Fit a 16:9 box (380 x 214 at 100 %) scaled by the size setting.
        const pct = Math.max(10, Math.min(200, Number(settings.pip_size) || 100)) / 100;
        const aspect = pipCanvas.width && pipCanvas.height ? pipCanvas.width / pipCanvas.height : 16 / 9;
        pipRoot.style.width = Math.min(380 * pct, 214 * pct * aspect) + "px";
        place(pipRoot, settings.pip_position || "bottom-right");
        pipRoot.querySelector(".dio-pip-name").textContent = pip.name || "";
        pipFps = Math.max(2, Math.min(60, Number(settings.pip_fps) || 30));
        if (!pipLoop) pipLoop = runPip();
    };
    // Frames at the chosen rate, separate from the state poll; drawn on a
    // canvas so there's no flicker between images.
    let pipFps = 30, pipLoop = null;
    const pipCanvas = document.createElement("canvas");
    pipCanvas.style.cssText = "display:block;width:100%";
    pipRoot.querySelector("img").replaceWith(pipCanvas);
    const runPip = async () => {
        try {
            while (!stopped && !pipRoot.hidden) {
                const t0 = performance.now();
                try {
                    const r = await fetch(STATE_URL.replace(/\/$/, "") + "/pip.jpg", { cache: "no-store" });
                    const seq = r.headers.get("X-Seq");
                    if (r.ok && seq !== pipSeq) {
                        pipSeq = seq;
                        const bmp = await createImageBitmap(await r.blob());
                        if (pipCanvas.width !== bmp.width) pipCanvas.width = bmp.width;
                        if (pipCanvas.height !== bmp.height) pipCanvas.height = bmp.height;
                        pipCanvas.getContext("2d").drawImage(bmp, 0, 0);
                        bmp.close();
                    }
                } catch (_) { }
                await new Promise((res) => setTimeout(res, Math.max(0, 1000 / pipFps - (performance.now() - t0))));
            }
        } finally { pipLoop = null; }
    };

    const render = (state) => {
        renderVoice(state);
        renderMessages(state);
        renderPip(state);
    };

    // Overlay options: size / opacity for everything, and "only show who's
    // talking" (the panel disappears when nobody is).
    const SIZES = { small: 0.8, normal: 1, large: 1.25 };
    const applyLook = (settings) => {
        const scale = SIZES[settings.overlay_size] || 1;
        const opacity = Math.max(0.3, Math.min(1, (Number(settings.overlay_opacity) || 100) / 100));
        for (const el of [root, msgRoot]) {
            el.style.opacity = String(opacity);
            el.style.zoom = String(scale);
        }
    };

    const renderVoice = (state) => {
        const settings = (state && state.settings) || {};
        applyLook(settings);
        let voice = state && state.voice;
        if (voice && settings.overlay_speakers_only) {
            const talking = (voice.members || []).filter((m) => m.speaking);
            voice = talking.length ? { ...voice, members: talking } : null;
        }
        if (!voice || settings.overlay_enabled === false || settings.overlay_engine_active !== "steam") {
            root.hidden = true;
            return;
        }
        root.hidden = false;
        place(root, settings.overlay_position || "top-left");

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
        msgRoot.remove();
        pipRoot.remove();
        style.remove();
        delete window.__discordioOverlay;
        delete window.__discordioOverlayStop;
        return "stopped";
    };
    return "started";
})()
