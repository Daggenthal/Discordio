// Discordio page bridge.
//
// Runs inside discord.com in the Steam view, before Discord's own code. Uses
// Vencord's webpack helpers to reach Discord's internal stores and actions,
// and talks to the Discordio backend over one websocket:
//
//   backend -> page   {t:"req", id, method, params}    -> {t:"res", id, ok, result|error}
//   page -> backend   {t:"event", name, data}           (state, notification, mic, ...)
//   backend -> page   {t:"push", name, data}            (mic answers, etc.)
//
// Every Discord internal is looked up defensively: when Discord renames
// something, that one feature fails with a readable error instead of the
// whole bridge breaking.
(() => {
    // Only in the top-level page: Discord embeds frames, and a bridge in each
    // of them kept knocking the real page's connection off.
    if (window.top !== window) return;
    if (window.DISCORDIO) return;
    const CFG = window.DISCORDIO_CONFIG || {};
    const VERSION = CFG.version || "dev";
    const log = (...a) => console.log("[Discordio]", ...a);
    const warn = (...a) => console.warn("[Discordio]", ...a);

    // ------------------------------------------------------------ connection
    const methods = {};
    const pushListeners = {};
    let ws = null, ready = false, backoff = 500;

    const send = (msg) => {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
    };
    const emit = (name, data) => send({ t: "event", name, data });

    function connect() {
        try {
            ws = new WebSocket(CFG.bridgeUrl || "ws://127.0.0.1:65123/bridge");
        } catch (e) {
            setTimeout(connect, backoff);
            return;
        }
        ws.onopen = () => {
            backoff = 500;
            if (ready) hello();
        };
        ws.onmessage = async (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch (_) { return; }
            if (msg.t === "req") {
                const fn = methods[msg.method];
                if (!fn) return send({ t: "res", id: msg.id, ok: false, error: `unknown method ${msg.method}` });
                if (!ready && msg.method !== "ping") return send({ t: "res", id: msg.id, ok: false, error: "Discord is still loading" });
                try {
                    const result = await fn(msg.params || {});
                    send({ t: "res", id: msg.id, ok: true, result: result === undefined ? null : result });
                } catch (e) {
                    warn(`${msg.method} failed:`, e);
                    send({ t: "res", id: msg.id, ok: false, error: String((e && e.message) || e) });
                }
            } else if (msg.t === "push") {
                for (const fn of pushListeners[msg.name] || []) {
                    try { fn(msg.data); } catch (e) { warn("push handler", msg.name, e); }
                }
            }
        };
        ws.onclose = () => {
            setTimeout(connect, backoff);
            backoff = Math.min(5000, backoff * 2);
        };
        ws.onerror = () => { try { ws.close(); } catch (_) { } };
    }

    function hello() {
        send({ t: "hello", version: VERSION });
        pushState(true);
    }

    window.DISCORDIO = {
        version: VERSION,
        emit,
        method: (name, fn) => { methods[name] = fn; },
        onPush: (name, fn) => { (pushListeners[name] = pushListeners[name] || []).push(fn); },
        get ready() { return ready; },
        log, warn,
    };

    // Settings the backend updates while running (e.g. the capture helper's
    // address after it restarts).
    window.DISCORDIO.onPush("config", (d) => {
        window.DISCORDIO_CONFIG = window.DISCORDIO_CONFIG || {};
        Object.assign(window.DISCORDIO_CONFIG, d || {});
    });

    // --------------------------------------------------------------- Discord
    const W = () => Vencord.Webpack;
    const C = () => Vencord.Webpack.Common;
    const storeCache = {};
    function store(name) {
        if (storeCache[name]) return storeCache[name];
        try {
            const s = W().findStore(name);
            if (s) storeCache[name] = s;
            return s || null;
        } catch (_) { return null; }
    }
    function props(...names) {
        try { return W().findByProps(...names) || null; } catch (_) { return null; }
    }
    function flux() {
        const f = C().FluxDispatcher;
        if (!f) throw new Error("Discord's event dispatcher wasn't found");
        return f;
    }
    const dispatch = (ev) => flux().dispatch(ev);

    const userName = (u) => (u ? (u.globalName || u.global_name || u.username) : "Unknown");
    const avatarUrl = (u) => (u && u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.webp?size=64` : null);
    const me = () => { try { return C().UserStore.getCurrentUser(); } catch (_) { return null; } };
    const voiceChannelId = () => { try { return store("SelectedChannelStore").getVoiceChannelId(); } catch (_) { return null; } };

    // Who's talking, per voice context: a Go Live stream's audio ("stream")
    // raised and cleared its own speaking events, which could leave someone
    // stuck as talking in the "default" (voice) context.
    const speaking = new Set();
    function isSpeaking(userId, muted) {
        if (muted) return false;
        try {
            const S = store("SpeakingStore");
            if (S && S.isSpeaking) return !!S.isSpeaking(userId, "default");
        } catch (_) { }
        return speaking.has(userId);
    }

    function voiceMembers(channelId) {
        const VS = store("VoiceStateStore");
        if (!VS) return [];
        let states = {};
        try { states = VS.getVoiceStatesForChannel(channelId) || {}; } catch (_) { }
        const M = store("MediaEngineStore");
        return Object.values(states).map((s) => {
            const u = C().UserStore.getUser(s.userId);
            let localMuted = false, volume = 100;
            try { localMuted = !!(M && M.isLocalMute && M.isLocalMute(s.userId, "default")); } catch (_) { }
            try { if (M && M.getLocalVolume) volume = Math.round(M.getLocalVolume(s.userId, "default")); } catch (_) { }
            return {
                id: s.userId, name: friendName(u) || userName(u), avatar: avatarUrl(u),
                muted: !!(s.selfMute || s.mute), deafened: !!(s.selfDeaf || s.deaf),
                server_muted: !!s.mute, server_deafened: !!s.deaf,
                local_muted: localMuted, volume,
                live: !!s.selfStream, video: !!s.selfVideo,
                speaking: isSpeaking(s.userId, !!(s.selfMute || s.mute || s.selfDeaf || s.deaf)),
            };
        });
    }

    function voiceInfo() {
        const id = voiceChannelId();
        if (!id) return null;
        const ch = C().ChannelStore.getChannel(id);
        const guild = ch && ch.guild_id ? C().GuildStore.getGuild(ch.guild_id) : null;
        const dmName = ch && !ch.guild_id
            ? (ch.name || (ch.recipients || []).map((r) => userName(C().UserStore.getUser(r))).join(", "))
            : null;
        return {
            channel_id: id,
            can: modPermissions(ch),
            me: (me() || {}).id || null,
            channel_name: dmName || (ch && ch.name) || "Voice",
            guild_id: (ch && ch.guild_id) || null,
            guild_name: guild ? guild.name : "Direct call",
            members: voiceMembers(id),
        };
    }

    function isLive() {
        try {
            const s = store("ApplicationStreamingStore");
            if (s && s.getCurrentUserActiveStream && s.getCurrentUserActiveStream()) return true;
        } catch (_) { }
        try { return store("MediaEngineStore").getGoLiveSource() != null; } catch (_) { return false; }
    }

    function media() {
        const M = store("MediaEngineStore");
        let mute = false, deaf = false;
        try { mute = !!M.isSelfMute(); deaf = !!M.isSelfDeaf(); } catch (_) { }
        return { mute, deaf, live: isLive() };
    }

    function buildState() {
        const u = me();
        return {
            loggedIn: !!u,
            user: u ? { id: u.id, name: userName(u), handle: u.username || null, avatar: u.avatar || null, avatarUrl: avatarUrl(u), premiumType: u.premiumType ?? 0 } : null,
            media: media(),
            voice: voiceInfo(),
            status: myStatus(),
        };
    }

    // ------------------------------------------------------------- status
    const STATUSES = ["online", "idle", "dnd", "invisible"];
    // A custom status emoji: a picture (animated when it is) or a unicode character.
    function statusEmoji(e) {
        if (!e) return null;
        if (e.id) return { url: `https://cdn.discordapp.com/emojis/${e.id}.webp?size=48&animated=true`, name: e.name || "" };
        return e.name ? { text: e.name } : null;
    }
    function myStatus() {
        const u = me();
        if (!u) return null;
        let status = "online", custom = null, emoji = null;
        try {
            const set = discordSetting("status", "status");
            const v = set && set.getSetting && set.getSetting();
            status = (STATUSES.includes(v) ? v : null) || store("PresenceStore").getStatus(u.id) || "online";
        } catch (_) { }
        try {
            const set = discordSetting("status", "customStatus");
            const v = set && set.getSetting && set.getSetting();
            if (v && (v.text || v.emojiId || v.emojiName)) {
                custom = v.text || "";
                emoji = statusEmoji({ id: v.emojiId && v.emojiId !== "0" ? String(v.emojiId) : null, name: v.emojiName });
            }
        } catch (_) { }
        if (custom === null) {
            try {
                const acts = store("PresenceStore").getActivities(u.id) || [];
                const c = acts.find((a) => a.type === 4);
                if (c && (c.state || c.emoji)) { custom = c.state || ""; emoji = statusEmoji(c.emoji); }
            } catch (_) { }
        }
        return { status, custom, emoji };
    }

    // Discord's synced user settings (through Vencord's settings API when
    // it's available).
    function discordSetting(group, name) {
        try {
            const api = Vencord.Api && Vencord.Api.UserSettings;
            if (api && api.getUserSetting) return api.getUserSetting(group, name) || null;
        } catch (_) { }
        return null;
    }

    // emoji: undefined/null keeps the current one, "none" removes it,
    // { id, name } is a custom emoji, { name } a unicode one.
    // clearAfter: minutes until it clears, "today" (midnight), or 0 / null = never.
    async function setStatus(status, custom, emoji, clearAfter) {
        const out = {};
        if (status !== undefined && status !== null) {
            if (!STATUSES.includes(status)) throw new Error("Unknown status " + status);
            const set = discordSetting("status", "status");
            if (set && set.updateSetting) { await set.updateSetting(status); out.status = "setting"; }
            else { await C().RestAPI.patch({ url: "/users/@me/settings", body: { status } }); out.status = "rest"; }
        }
        if (custom !== undefined && custom !== null) {
            const text = String(custom).trim().slice(0, 128);
            let expires = 0;
            if (clearAfter === "today") { const d = new Date(); d.setHours(24, 0, 0, 0); expires = d.getTime(); }
            else if (Number(clearAfter) > 0) expires = Date.now() + Number(clearAfter) * 60000;
            const set = discordSetting("status", "customStatus");
            let prev = null;
            try { prev = set && set.getSetting && set.getSetting(); } catch (_) { }
            let emojiId = null, emojiName = null;
            if (emoji === "none") { /* removed */ }
            else if (emoji && (emoji.id || emoji.name)) { emojiId = emoji.id ? String(emoji.id) : null; emojiName = emoji.name || null; }
            else if (prev) { emojiId = prev.emojiId && prev.emojiId !== "0" ? String(prev.emojiId) : null; emojiName = prev.emojiName || null; }
            const empty = !text && !emojiId && !emojiName;
            // Discord's own setting updates this client right away; the request
            // makes sure Discord's servers (and your other devices) have it too,
            // which the setting alone didn't always do.
            if (set && set.updateSetting) {
                try {
                    await set.updateSetting(empty ? undefined : {
                        text, expiresAtMs: String(expires || 0),
                        ...(emojiId ? { emojiId } : {}), ...(emojiName ? { emojiName } : {}),
                    });
                    out.custom = "setting";
                } catch (e) { warn("custom status setting", e); }
            }
            try {
                await C().RestAPI.patch({ url: "/users/@me/settings", body: { custom_status: empty ? null : {
                    text, emoji_id: emojiId, emoji_name: emojiName, expires_at: expires ? new Date(expires).toISOString() : null,
                } } });
                out.custom = out.custom ? out.custom + "+rest" : "rest";
            } catch (e) {
                warn("custom status request", e);
                if (!out.custom) throw new Error("Discord didn't accept the custom status");
            }
        }
        setTimeout(() => pushState(true), 500);
        return { ok: true, ...out, now: myStatus() };
    }

    let stateTimer = null, lastState = "";
    function pushState(force) {
        if (stateTimer && !force) return;
        clearTimeout(stateTimer);
        stateTimer = setTimeout(() => {
            stateTimer = null;
            if (!ready) return;
            let s;
            try { s = buildState(); } catch (e) { warn("state", e); return; }
            const json = JSON.stringify(s);
            if (json === lastState && !force) return;
            lastState = json;
            emit("state", s);
        }, force ? 0 : 50);
    }

    // ---------------------------------------------------------- voice / calls
    function selectVoice(guildId, channelId) {
        const actions = props("selectVoiceChannel");
        if (actions && actions.selectVoiceChannel) {
            actions.selectVoiceChannel(channelId);
            return "action";
        }
        dispatch({
            type: "VOICE_CHANNEL_SELECT", guildId, channelId,
            currentVoiceChannelId: voiceChannelId(), video: false, stream: false,
        });
        return "dispatch";
    }

    function toggle(actionName, eventType) {
        const a = props(actionName);
        if (a && a[actionName]) a[actionName]();
        else dispatch({ type: eventType, context: "default", syncRemote: true });
        return media();
    }

    // ------------------------------------------------------------- streaming
    function streamLimits() {
        const u = me() || {};
        const pt = u.premiumType ?? 0;
        const plan = { 0: "No Nitro", 1: "Nitro Classic", 2: "Nitro", 3: "Nitro Basic" }[pt] || "No Nitro";
        // Free: 720p 30. Nitro / Classic: source at 60. Nitro Basic has no HD
        // streaming. Server boosts lift everyone in that server:
        // level 1 = 720p 60, level 2+ = 1080p 60.
        let maxHeight = 720, maxFps = 30, reason = plan, boost = 0;
        if (pt === 1 || pt === 2) { maxHeight = null; maxFps = 60; }
        try {
            const v = voiceInfo();
            const g = v && v.guild_id && C().GuildStore.getGuild(v.guild_id);
            if (g) boost = g.premiumTier || 0;
            if (maxHeight !== null && boost >= 1) {
                const cap = boost >= 2 ? [1080, 60] : [720, 60];
                if (cap[0] > maxHeight || cap[1] > maxFps) {
                    maxHeight = Math.max(maxHeight, cap[0]);
                    maxFps = Math.max(maxFps, cap[1]);
                    reason = `${g.name} server boost level ${boost}`;
                }
            }
        } catch (_) { }
        return { premium_type: pt, plan, max_height: maxHeight, max_fps: maxFps, reason, boost_level: boost };
    }

    function applyStreamQuality(q) {
        // Clamped to what the account allows; never unlocks paid quality.
        try {
            const lim = streamLimits();
            let h = q.resolution === "source" ? 0 : parseInt(q.resolution, 10) || 720;
            if (lim.max_height !== null && (h === 0 || h > lim.max_height)) h = lim.max_height;
            const fps = Math.min(parseInt(q.fps, 10) || 30, lim.max_fps);
            dispatch({ type: "STREAM_UPDATE_SETTINGS", preset: 3, resolution: h, frameRate: fps });
        } catch (e) { warn("stream quality", e); }
    }

    // Go Live the way you would in Discord: press its Share Screen button
    // (and Go Live in its dialog if one opens). That path asks for the
    // screen (getDisplayMedia, answered with the game) and wires it to the
    // stream. Calling Discord's stream function directly registered a
    // stream with no video attached: viewers got error 2015 until the
    // stream was changed from inside Discord.
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    async function waitFor(cond, ms) {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            const v = cond();
            if (v) return v;
            await sleep(150);
        }
        return null;
    }
    const visible = (el) => !!(el && (el.offsetParent !== null || el.getClientRects().length));
    // The Discord view is usually hidden, so a button can be in the page
    // without being "visible": prefer visible matches, else take any.
    function findButton(pattern, root) {
        const els = [...(root || document).querySelectorAll("button, [role=button]")].filter((el) => {
            const label = el.getAttribute("aria-label") || el.textContent || "";
            return pattern.test(label.trim()) && !el.disabled && el.getAttribute("aria-disabled") !== "true";
        });
        return els.find(visible) || els[0] || null;
    }
    function similarButtons() {
        const labels = new Set();
        for (const el of document.querySelectorAll("button[aria-label], [role=button][aria-label]")) {
            const l = el.getAttribute("aria-label");
            if (/screen|stream|live|share|camera|activity/i.test(l)) labels.add(l);
        }
        return [...labels].slice(0, 12).join(", ") || "none";
    }
    const dialogs = () => [...document.querySelectorAll("[role=dialog], [class*=modal]")];

    // Open the call's own page, where Discord draws the full call controls.
    function openCallPage(vc) {
        try {
            const ch = C().ChannelStore.getChannel(vc);
            const path = `/channels/${(ch && ch.guild_id) || "@me"}/${vc}`;
            if (location.pathname === path) return false;
            const nav = (C().NavigationRouter) || props("transitionTo", "replaceWith");
            if (nav && nav.transitionTo) { nav.transitionTo(path); return true; }
            window.history.pushState({}, "", path);
            dispatchEvent(new PopStateEvent("popstate"));
            return true;
        } catch (e) { warn("open call page", e); return false; }
    }

    function pageInfo() {
        const buttons = document.querySelectorAll("button, [role=button]").length;
        const labels = [...document.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label")).filter(Boolean);
        return `page ${location.pathname}, ${document.visibilityState}, ${innerWidth}x${innerHeight}, ` +
            `${buttons} buttons, labels: ${[...new Set(labels)].slice(0, 25).join(" | ")}`;
    }

    const SHARE = /^(share (your )?screen|go live|screen ?share)/i;
    async function startViaUi(tried, vc) {
        const before = window.DISCORDIO.captureRequests || 0;
        const captured = () => (window.DISCORDIO.captureRequests || 0) !== before;
        let share = findButton(SHARE);
        if (!share && vc && openCallPage(vc)) {
            log("Go Live: opened the call page to reach Share Screen");
            share = await waitFor(() => findButton(SHARE), 3000);
        }
        if (!share) {
            tried.push(`ui: Share Screen button not found (similar buttons: ${similarButtons()})`);
            log("Go Live: no Share Screen button; " + pageInfo());
            return null;
        }
        log(`Go Live: pressing "${share.getAttribute("aria-label") || share.textContent.trim()}"`);
        share.click();
        if (await waitFor(captured, 2500)) return { method: "ui" };
        // Discord's Go Live dialog (quality / source): press its Go Live.
        const go = await waitFor(() => {
            for (const d of dialogs()) {
                const b = findButton(/^go live$/i, d);
                if (b) return b;
            }
            return null;
        }, 4000);
        if (!go) { tried.push("ui: no Go Live button in Discord's dialog"); return null; }
        log("Go Live: confirming in Discord's dialog");
        go.click();
        if (await waitFor(captured, 8000)) return { method: "ui+dialog" };
        tried.push("ui: Discord didn't ask for the screen after Go Live");
        return null;
    }

    function setGoLiveSource(quality) {
        const q = quality || {};
        const height = q.resolution === "source" ? 1080 : Number(q.resolution) || 720;
        const fps = Number(q.fps) || 30;
        const settings = {
            desktopSettings: { sourceId: "screen:0:0", sound: true },
            qualityOptions: { preset: 3, resolution: height, frameRate: fps },
            context: "stream",
        };
        const a = props("setGoLiveSource");
        if (a && a.setGoLiveSource) {
            try { a.setGoLiveSource(settings); return "setGoLiveSource"; } catch (e) { warn("setGoLiveSource", e); }
        }
        try {
            const M = store("MediaEngineStore");
            const engine = M && M.getMediaEngine && M.getMediaEngine();
            if (engine && engine.setGoLiveSource) { engine.setGoLiveSource(settings, "stream"); return "engine"; }
        } catch (e) { warn("engine.setGoLiveSource", e); }
        dispatch({ type: "MEDIA_ENGINE_SET_GO_LIVE_SOURCE", settings });
        return "dispatch";
    }

    async function goLive(stop, quality, uiOnly) {
        const vc = voiceChannelId();
        if (!stop && !vc) throw new Error("Join a voice channel or call first");
        if (!stop && quality) applyStreamQuality(quality);
        const tried = [];
        if (!stop) {
            try {
                const r = await startViaUi(tried, vc);
                if (r) return r;
            } catch (e) { tried.push("ui: " + e); }
            // The backend retries with the Discord view shown before falling back.
            if (uiOnly) throw new Error("NO_SHARE_BUTTON: " + tried.join("; "));
            // Fallback: Discord's stream function, only kept if Discord then
            // actually asks for the screen.
            try {
                const fn = W().find((m) => typeof m === "function" && m.length >= 2 &&
                    /STREAM_START|streamType/.test(m.toString()) && /analyticsLocation|appContext/.test(m.toString()), { isIndirect: true });
                if (fn) {
                    const ch = C().ChannelStore.getChannel(vc);
                    const before = window.DISCORDIO.captureRequests || 0;
                    const captured = () => (window.DISCORDIO.captureRequests || 0) !== before;
                    await fn((ch && ch.guild_id) || null, vc, "Activity Panel");
                    if (await waitFor(captured, 2500)) return { method: "action" };
                    // What the Share Screen button does besides starting the
                    // stream: give Discord's media engine a source, which makes
                    // it ask for the screen (answered with the game).
                    const how = setGoLiveSource(quality);
                    tried.push("source: " + how);
                    if (await waitFor(captured, 5000)) return { method: "action+source" };
                    tried.push("action: started a stream without video");
                    // Don't leave a stream with no video up: viewers get error 2015.
                    await goLive(true).catch(() => { });
                } else {
                    tried.push("action: not found");
                }
            } catch (e) { tried.push("action: " + e); }
            warn("Go Live failed:", tried.join("; "));
            throw new Error(`Couldn't start the stream (${tried.join("; ")}). Starting it from inside Discord works as a fallback.`);
        }
        try {
            const b = findButton(/^stop (streaming|sharing)/i);
            if (b) { b.click(); return { method: "ui" }; }
            tried.push("ui: button not found");
        } catch (e) { tried.push("ui: " + e); }
        try {
            const s = store("ApplicationStreamingStore");
            const a = s && s.getCurrentUserActiveStream && s.getCurrentUserActiveStream();
            if (!a) return { method: "none" };
            const key = [a.streamType, a.guildId, a.channelId, a.ownerId].filter(Boolean).join(":");
            dispatch({ type: "STREAM_STOP", streamKey: key, appContext: "APP" });
            return { method: "dispatch" };
        } catch (e) { tried.push("dispatch: " + e); }
        throw new Error(`Couldn't stop the stream (${tried.join("; ")})`);
    }

    // ----------------------------------------------------------- screenshots
    async function postScreenshot(channelId, b64, filename) {
        const RestAPI = C().RestAPI;
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const name = filename || "screenshot.jpg";
        // Discord's attachment flow: reserve an upload URL, PUT the file, send.
        const res = await RestAPI.post({
            url: `/channels/${channelId}/attachments`,
            body: { files: [{ filename: name, file_size: bytes.length, id: "0" }] },
        });
        const att = res && res.body && res.body.attachments && res.body.attachments[0];
        if (!att) throw new Error("Discord didn't give an upload URL");
        const type = /\.png$/i.test(name) ? "image/png" : "image/jpeg";
        const put = await fetch(att.upload_url, { method: "PUT", body: new Blob([bytes], { type }) });
        if (!put.ok) throw new Error(`upload failed (HTTP ${put.status})`);
        await RestAPI.post({
            url: `/channels/${channelId}/messages`,
            body: {
                content: "",
                nonce: C().SnowflakeUtils ? C().SnowflakeUtils.fromTimestamp(Date.now()) : String(Date.now()),
                attachments: [{ id: "0", filename: name, uploaded_filename: att.upload_filename }],
            },
        });
        return { ok: true };
    }

    function recentTextChannels() {
        const out = [];
        const seen = new Set();
        const add = (id) => {
            if (!id || seen.has(id)) return;
            const ch = C().ChannelStore.getChannel(id);
            if (!ch) return;
            seen.add(id);
            const g = ch.guild_id ? C().GuildStore.getGuild(ch.guild_id) : null;
            const label = g ? `#${ch.name} (${g.name})`
                : ch.name || (ch.recipients || []).map((r) => userName(C().UserStore.getUser(r))).join(", ") || "Direct message";
            out.push({ id, label });
        };
        try {
            const raw = JSON.parse(Vencord.Util.localStorage.SelectedChannelStore || "{}");
            Object.values(raw.mostRecentSelectedTextChannelIds || {}).forEach(add);
        } catch (_) { }
        try { add(store("SelectedChannelStore").getChannelId()); } catch (_) { }
        try {
            const PS = store("PrivateChannelSortStore");
            (PS && PS.getPrivateChannelIds ? PS.getPrivateChannelIds() : []).slice(0, 8).forEach(add);
        } catch (_) { }
        return out.slice(0, 15);
    }

    // ----------------------------------------------------------- game status
    const appIds = {};
    let detectable = null;
    async function setActivity(game) {
        let appId = "0";
        if (game) {
            if (appIds[game]) appId = appIds[game];
            else {
                try {
                    if (!detectable) {
                        const r = await C().RestAPI.get({ url: "/applications/detectable" });
                        detectable = (r && r.body) || [];
                    }
                    const hit = detectable.find((a) => a.name === game);
                    if (hit) appId = appIds[game] = hit.id;
                } catch (_) { }
            }
        }
        dispatch({
            type: "LOCAL_ACTIVITY_UPDATE",
            activity: game ? { application_id: appId, name: game, type: 0, flags: 1, timestamps: { start: Date.now() } } : {},
            socketId: "Discordio",
        });
        return { ok: true };
    }

    // ------------------------------------------------------------------ lists
    function guilds() {
        const GS = C().GuildStore || store("GuildStore");
        if (!GS) throw new Error("Discord's server list wasn't found");
        let ids = [];
        const sorted = store("SortedGuildStore");
        try { ids = sorted.getFlattenedGuildIds() || []; } catch (_) { }
        if (!ids.length) { try { ids = (sorted.getGuildFolders() || []).flatMap((f) => f.guildIds || []); } catch (_) { } }
        if (!ids.length) { try { ids = GS.getGuildIds ? GS.getGuildIds() : []; } catch (_) { } }
        if (!ids.length) {
            try { const all = GS.getGuilds(); ids = all instanceof Map ? [...all.keys()] : Object.keys(all || {}); } catch (_) { }
        }
        return ids.map((id) => { try { return GS.getGuild(id); } catch (_) { return null; } }).filter(Boolean).map((g) => ({
            id: g.id, name: g.name,
            icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.webp?size=64` : null,
            ...(() => { const r = guildReadState(g.id); return { unread: r.has, mentions: r.mentions, muted: discordMuted(g.id, null) }; })(),
        }));
    }

    function voiceChannels(guildId) {
        let list = [];
        try {
            const GCS = store("GuildChannelStore");
            const vocal = GCS && GCS.getChannels(guildId) && GCS.getChannels(guildId).VOCAL;
            if (vocal) list = vocal.map((v) => v.channel || v).filter(Boolean);
        } catch (_) { }
        if (!list.length) {
            const all = C().ChannelStore.getMutableGuildChannelsForGuild(guildId) || {};
            list = Object.values(all).filter((c) => c.type === 2 || c.type === 13).sort((a, b) => (a.position || 0) - (b.position || 0));
        }
        return list.map((c) => ({ id: c.id, name: c.name, members: voiceMembers(c.id) }));
    }

    // Which voice channel a friend is in (only for servers / calls you
    // share, like in Discord), and whether they're streaming there.
    function friendVoice(userId) {
        try {
            const VS = store("VoiceStateStore");
            const st = VS && (VS.getVoiceStateForUser ? VS.getVoiceStateForUser(userId) : null);
            if (!st || !st.channelId) return null;
            const ch = C().ChannelStore.getChannel(st.channelId);
            if (!ch) return null;
            const g = ch.guild_id ? C().GuildStore.getGuild(ch.guild_id) : null;
            return {
                channel_id: ch.id, channel_name: ch.name || "Call", guild_name: g ? g.name : "Direct call",
                streaming: !!st.selfStream, mine: voiceChannelId() === ch.id,
            };
        } catch (_) { return null; }
    }

    // Watch someone's Go Live (Discord shows it; the QAM opens Discord).
    // ------------------------------------------------- stream in the overlay
    // Frames of a stream you watch, small JPEGs a few times a second, for the
    // in-game overlay's picture-in-picture. Read straight from the video
    // track, so it works with the Discord view hidden.
    let pip = null;
    let watching = null; // stream key being watched
    // media.js (loaded after this file) adds its helpers to window.DISCORDIO.media.
    const remoteVideo = (since) => {
        const m = (window.DISCORDIO || {}).media;
        return m && m.latestRemoteVideo ? m.latestRemoteVideo(since) : null;
    };
    const remoteCandidates = (since) => {
        const m = (window.DISCORDIO || {}).media;
        return m && m.remoteVideoCandidates ? m.remoteVideoCandidates(since) : [];
    };
    // Is this track actually delivering pictures? A stream watched before
    // can leave a track behind that's "live" but black.
    async function hasFrames(track, ms) {
        if (!window.MediaStreamTrackProcessor) return !track.muted;
        const c = track.clone();
        const r = new MediaStreamTrackProcessor({ track: c }).readable.getReader();
        try {
            const res = await Promise.race([r.read(), sleep(ms).then(() => null)]);
            if (res && res.value) { res.value.close(); return true; }
            return false;
        } catch (_) { return false; } finally {
            try { r.cancel(); } catch (_) { }
            try { c.stop(); } catch (_) { }
        }
    }
    async function findStreamVideo(since, st, tries) {
        for (let i = 0; i < (tries || 40) && st.on; i++) {
            for (const t of remoteCandidates(since)) {
                if (!st.on) return null;
                if (await hasFrames(t, 700)) return t;
            }
            await sleep(400);
        }
        return null;
    }
    const blobToB64 = (blob) => new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
        fr.onerror = reject;
        fr.readAsDataURL(blob);
    });
    function pipStart({ since, width, fps, name }) {
        fps = Number(fps) || 30;
        pipStop(true);
        width = Math.max(160, Math.min(960, width || 480));
        const st = { on: true, seq: 0, fps: Math.max(2, Math.min(60, fps || 30)) };
        pip = st;
        (async () => {
            const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, Math.round(width * 9 / 16)) : null;
            if (!canvas) { emit("pip", { error: "this browser can't draw the frames" }); return; }
            const ctx = canvas.getContext("2d");
            const send = async (src, sw, sh) => {
                if (!sw || !sh) return;
                const h = Math.max(2, Math.round(width * sh / sw));
                if (canvas.height !== h) canvas.height = h;
                ctx.drawImage(src, 0, 0, width, h);
                const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.72 });
                emit("pip_frame", { seq: ++st.seq, data: await blobToB64(blob), w: width, h, name: name || null });
            };
            let started = false, lost = 0;
            while (st.on) {
                // Find the stream's video (again, if it went black).
                const track = await findStreamVideo((since || 0) - 2000, st, started ? 15 : 40);
                if (!st.on) break;
                if (!track) {
                    if (!started) { emit("pip", { error: "the stream's video didn't arrive" }); st.on = false; break; }
                    // The streamer paused (a phone locked, an app in the
                    // background): keep waiting for the picture to come back
                    // for as long as we're watching.
                    if (!watching) break;
                    lost++;
                    await sleep(Math.min(3000, 500 * lost));
                    continue;
                }
                lost = 0;
                const clone = track.clone();
                st.track = clone;
                if (!started) { started = true; emit("pip", { started: true, how: window.MediaStreamTrackProcessor ? "track" : "video" }); }
                let last = 0;
                if (window.MediaStreamTrackProcessor) {
                    const reader = new MediaStreamTrackProcessor({ track: clone }).readable.getReader();
                    st.reader = reader;
                    while (st.on) {
                        let r;
                        try { r = await Promise.race([reader.read(), sleep(3000).then(() => null)]); } catch (_) { break; }
                        if (!r || r.done) break; // stalled or ended: look for the video again
                        const frame = r.value;
                        const now = performance.now();
                        if (now - last >= 1000 / st.fps - 2) {
                            last = now;
                            try { await send(frame, frame.displayWidth, frame.displayHeight); } catch (e) { warn("pip frame", e); }
                        }
                        frame.close();
                    }
                    try { reader.cancel(); } catch (_) { }
                } else {
                    const v = document.createElement("video");
                    v.muted = true; v.playsInline = true; v.srcObject = new MediaStream([clone]);
                    try { await v.play(); } catch (_) { }
                    while (st.on && clone.readyState === "live") {
                        await sleep(1000 / st.fps);
                        try { await send(v, v.videoWidth, v.videoHeight); } catch (_) { }
                    }
                    v.srcObject = null;
                }
                try { clone.stop(); } catch (_) { }
            }
            if (pip === st) { pip = null; emit("pip", { stopped: true }); }
        })();
        return { ok: true };
    }
    function pipFps(fps) {
        if (pip) pip.fps = Math.max(2, Math.min(60, Number(fps) || 30));
        return { ok: true };
    }
    function pipStop(quiet) {
        const st = pip;
        if (!st) return { ok: true };
        pip = null;
        st.on = false;
        try { st.reader && st.reader.cancel(); } catch (_) { }
        try { st.track && st.track.stop(); } catch (_) { }
        if (!quiet) emit("pip", { stopped: true });
        return { ok: true };
    }
    // Full-screen player inside the Discord view: just the stream, no Discord
    // around it. The Discord tab's B button stops watching and goes back.
    let player = null;
    function showPlayer({ since, name }) {
        hidePlayer();
        const el = document.createElement("div");
        el.id = "discordio-player";
        el.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#000;display:flex;align-items:center;justify-content:center";
        el.innerHTML = '<video autoplay playsinline muted style="width:100%;height:100%;object-fit:contain"></video>' +
            '<div class="dio-p-msg" style="position:absolute;color:#fff;font:600 22px sans-serif;opacity:.85;text-align:center"></div>' +
            '<div style="position:absolute;left:24px;bottom:20px;display:flex;gap:10px;align-items:center;color:#fff;font:600 16px sans-serif;text-shadow:0 1px 3px #000">' +
            '<span style="background:#ed4245;border-radius:4px;padding:2px 7px;font-size:13px">LIVE</span><span class="dio-p-name"></span>' +
            '<span style="opacity:.7;font-weight:400">· press B to stop watching</span></div>';
        el.querySelector(".dio-p-name").textContent = name || "";
        document.body.appendChild(el);
        const st = { el, on: true };
        player = st;
        const msg = (t) => { const m = el.querySelector(".dio-p-msg"); if (m) m.textContent = t || ""; };
        msg("Waiting for the stream's video...");
        (async () => {
            const v = el.querySelector("video");
            let lastFrame = 0;
            const tick = () => { lastFrame = performance.now(); if (st.on && v.requestVideoFrameCallback) v.requestVideoFrameCallback(tick); };
            let first = true;
            while (st.on) {
                const track = await findStreamVideo((since || 0) - 2000, st, first ? 40 : 15);
                if (!st.on) return;
                if (!track) {
                    if (first) {
                        msg("The stream's video didn't arrive. Press B to go back.");
                        emit("pip", { error: "the stream's video didn't arrive (player)" });
                        return;
                    }
                    if (!watching) { msg("The stream ended. Press B to go back."); return; }
                    // Paused on their side (a phone locked): wait for it.
                    msg("Stream paused. Waiting for it to come back...");
                    await sleep(1500);
                    continue;
                }
                first = false;
                v.srcObject = new MediaStream([track]);
                try { await v.play(); } catch (_) { }
                msg("");
                lastFrame = performance.now();
                if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(tick);
                // Went black: find the video again.
                while (st.on && track.readyState === "live" && (!v.requestVideoFrameCallback || performance.now() - lastFrame < 3000)) await sleep(500);
                if (!st.on) return;
                if (watching) msg("Reconnecting...");
                else { msg("The stream ended. Press B to go back."); return; }
            }
        })();
        return { ok: true };
    }
    function hidePlayer() {
        if (!player) return;
        player.on = false;
        try { const v = player.el.querySelector("video"); v.srcObject = null; } catch (_) { }
        player.el.remove();
        player = null;
    }
    // When the person stops streaming, stop showing it.
    const streamKey = (x) => [x.streamType, x.guildId, x.channelId, x.ownerId].filter(Boolean).join(":");
    setInterval(() => {
        if (!watching) return;
        try {
            const S = store("ApplicationStreamingStore");
            const all = (S && S.getAllApplicationStreams ? S.getAllApplicationStreams() : null);
            if (!all) return;
            if (all.some((x) => streamKey(x) === watching)) return;
        } catch (_) { return; }
        watching = null;
        pipStop(true);
        if (player) { const m = player.el.querySelector(".dio-p-msg"); if (m) m.textContent = "The stream ended. Press B to go back."; }
        emit("watch_ended", {});
    }, 2000);

    function stopWatching() {
        pipStop();
        hidePlayer();
        const key = watching;
        watching = null;
        if (!key) return { ok: true };
        const a = props("closeStream");
        try {
            if (a && a.closeStream) a.closeStream(key, false);
            else dispatch({ type: "STREAM_CLOSE", streamKey: key });
        } catch (e) { warn("closeStream", e); }
        return { ok: true };
    }

    async function watchStream(userId, inOverlay, fps, asPlayer) {
        const S = store("ApplicationStreamingStore");
        let stream = null;
        try {
            const all = (S && (S.getAllApplicationStreams ? S.getAllApplicationStreams() : [])) || [];
            stream = all.find((x) => x.ownerId === userId) || null;
        } catch (_) { }
        if (!stream) throw new Error("They aren't streaming right now");
        const key = streamKey(stream);
        // Watching a server stream means being in its voice channel.
        if (stream.channelId && voiceChannelId() !== stream.channelId) {
            selectVoice(stream.guildId || null, stream.channelId);
            await waitFor(() => voiceChannelId() === stream.channelId, 5000);
        }
        const a = props("watchStreamAndTransitionToStream") || props("watchStream");
        const since = Date.now();
        if (a && a.watchStreamAndTransitionToStream) a.watchStreamAndTransitionToStream(stream);
        else if (a && a.watchStream) a.watchStream(stream);
        else dispatch({ type: "STREAM_WATCH", streamKey: key, allowMultiple: true });
        watching = key;
        let name = null;
        try { const u = C().UserStore.getUser(userId); name = friendName(u) || userName(u); } catch (_) { }
        if (inOverlay) pipStart({ since, name, fps });
        if (asPlayer) showPlayer({ since, name });
        // Show the stream full-size in Discord's call page.
        try { openCallPage(stream.channelId); } catch (_) { }
        return { ok: true, name };
    }

    function friends() {
        const RS = store("RelationshipStore"), PS = store("PresenceStore");
        if (!RS) throw new Error("Discord's friends list wasn't found");
        let ids = [];
        try { ids = RS.getFriendIDs(); } catch (_) {
            const rel = RS.getRelationships ? RS.getRelationships() : {};
            ids = Object.keys(rel).filter((k) => rel[k] === 1 || (rel[k] && rel[k].type === 1));
        }
        const rank = { online: 0, idle: 1, dnd: 2, offline: 3 };
        return ids.map((id) => {
            const u = C().UserStore.getUser(id);
            return { id, name: friendName(u) || userName(u), avatar: avatarUrl(u), status: (PS && PS.getStatus(id)) || "offline", voice: friendVoice(id) };
        }).sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || a.name.localeCompare(b.name));
    }

    // ------------------------------------------------------------- badges
    let badgeCache = null;
    const fmtDate = (d) => d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    // "2y 3m", "3m", "12d"
    function since(dateLike) {
        const d = new Date(dateLike);
        if (isNaN(d)) return null;
        const now = new Date();
        let months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
        if (now.getDate() < d.getDate()) months -= 1;
        months = Math.max(0, months);
        const y = Math.floor(months / 12), m = months % 12;
        let short = [y ? `${y}y` : "", m ? `${m}m` : ""].filter(Boolean).join(" ");
        if (!short) short = `${Math.max(0, Math.floor((now - d) / 86400000))}d`;
        return { date: fmtDate(d), short, years: y };
    }
    const NITRO_TIERS = { 1: "Bronze", 3: "Silver", 6: "Gold", 12: "Platinum", 24: "Diamond", 36: "Emerald", 60: "Ruby", 72: "Opal" };
    const AGE_RANKS = ["Seed", "Sprout", "Sapling", "Bud", "Blossom", "Redwood", "Sequoia", "Bristlecone", "Stromatolite", "Primordial"];
    // After a colon, start with a capital letter.
    const tidy = (t) => String(t || "").replace(/(^|:\s*)([a-z])/g, (_, a, c) => a + c.toUpperCase());
    // Snowflake IDs carry their creation time.
    const createdAt = (id) => new Date(Number(BigInt(id) >> 22n) + 1420070400000);
    // Full profile from Discord's API (the store's copy can be partial).
    async function fetchProfile(userId) {
        let profile = null;
        try {
            const r = await C().RestAPI.get({ url: `/users/${userId}/profile`,
                query: { with_mutual_guilds: true, with_mutual_friends: true, with_mutual_friends_count: true } });
            profile = r && r.body;
        } catch (e) { warn("profile", e); }
        if (!profile || !Array.isArray(profile.badges)) {
            try {
                const P = store("UserProfileStore");
                const p = P && P.getUserProfile && P.getUserProfile(userId);
                if (p) profile = { ...p, ...(profile && !Array.isArray(profile) ? profile : {}), badges: p.badges };
            } catch (_) { }
        }
        return profile && !Array.isArray(profile) ? profile : {};
    }
    function badgesOf(profile, userId) {
        const premiumSince = profile.premium_since || profile.premiumSince || null;
        const boostSince = profile.premium_guild_since || profile.premiumGuildSince || null;
        const created = since(createdAt(userId));
        const nitro = premiumSince ? since(premiumSince) : null;
        const boost = boostSince ? since(boostSince) : null;
        const badges = (profile.badges || []).map((b) => {
            const id = String(b.id || "");
            let text = b.description || id;
            if (/account.?age/i.test(id + " " + text) && created) {
                const rank = AGE_RANKS[Math.min(AGE_RANKS.length, Math.max(1, created.years)) - 1];
                text = `${created.years >= 1 ? rank + ": " : ""}Account Created on ${created.date} (${created.short} ago)`;
            } else if (/premium(?!_guild)|nitro|subscriber/i.test(id) && nitro) {
                const mo = Number((id.match(/(\d+)_month/) || [])[1]);
                text = `${NITRO_TIERS[mo] || "Nitro"}: Subscribing since ${nitro.date} (${nitro.short})`;
            } else if (/guild_booster|boost/i.test(id) && boost) {
                text = `Server Boosting since ${boost.date} (${boost.short})`;
            }
            return { id, description: tidy(text), icon: b.icon ? `https://cdn.discordapp.com/badge-icons/${b.icon}.png` : null, link: b.link || null };
        });
        return { badges, created };
    }
    async function myBadges() {
        const u = me();
        if (!u) throw new Error("not logged in");
        if (badgeCache && badgeCache.id === u.id && Date.now() - badgeCache.at < 10 * 60 * 1000) return badgeCache.value;
        const { badges } = badgesOf(await fetchProfile(u.id), u.id);
        const value = { badges };
        badgeCache = { id: u.id, at: Date.now(), value };
        log("badges: " + badges.map((b) => `${b.id}="${b.description}"`).join(", "));
        return value;
    }

    const CONNECTIONS = { youtube: "YouTube", twitch: "Twitch", steam: "Steam", xbox: "Xbox", playstation: "PlayStation",
        spotify: "Spotify", github: "GitHub", twitter: "X", reddit: "Reddit", tiktok: "TikTok", instagram: "Instagram",
        battlenet: "Battle.net", epicgames: "Epic Games", riotgames: "Riot Games", leagueoflegends: "League of Legends",
        bluesky: "Bluesky", mastodon: "Mastodon", domain: "Website", facebook: "Facebook", paypal: "PayPal", ebay: "eBay",
        crunchyroll: "Crunchyroll", roblox: "Roblox", bungie: "Bungie.net" };
    const colorHex = (n) => (typeof n === "number" ? "#" + n.toString(16).padStart(6, "0") : null);
    // Everything Discord shows on a profile card.
    async function userProfile(userId) {
        const meU = me();
        userId = userId || (meU && meU.id);
        if (!userId) throw new Error("not logged in");
        const p = await fetchProfile(userId);
        const base = C().UserStore.getUser(userId) || (meU && meU.id === userId ? meU : null) || {};
        const u = { username: base.username, global_name: base.globalName || base.global_name, avatar: base.avatar,
            banner: base.banner, accent_color: base.accentColor, avatar_decoration_data: base.avatarDecorationData,
            primary_guild: base.primaryGuild, ...(p.user || {}) };
        const up = p.user_profile || p.userProfile || {};
        const banner = up.banner || u.banner || null;
        const deco = u.avatar_decoration_data || u.avatarDecorationData || null;
        const tag = u.primary_guild || u.primaryGuild || u.clan || null;
        const theme = up.theme_colors || up.themeColors || null;
        const status = (() => { try { return (store("PresenceStore") && store("PresenceStore").getStatus(userId)) || "offline"; } catch (_) { return "offline"; } })();
        let custom = null;
        try {
            const acts = (store("PresenceStore") && store("PresenceStore").getActivities(userId)) || [];
            const c = acts.find((a) => a.type === 4);
            if (c) { const e = statusEmoji(c.emoji); custom = { text: c.state || "", emoji: e ? (e.url || e.text) : null }; }
            var playing = acts.filter((a) => a.type !== 4).map((a) => ({ type: a.type, name: a.name, details: a.details || null, state: a.state || null }));
        } catch (_) { }
        if (userId === (meU && meU.id) && (!custom || !custom.emoji)) {
            try { const st = myStatus(); if (st && (st.custom || st.emoji)) custom = { text: st.custom || "", emoji: st.emoji ? (st.emoji.url || st.emoji.text) : null }; } catch (_) { }
        }
        const { badges, created } = badgesOf(p, userId);
        const avatar = u.avatar ? `https://cdn.discordapp.com/avatars/${userId}/${u.avatar}.${String(u.avatar).startsWith("a_") ? "gif" : "png"}?size=256` : avatarUrl(u);
        return {
            id: userId, me: userId === (meU && meU.id),
            name: friendName(u) || u.global_name || u.globalName || u.username, username: u.username || null,
            avatar,
            decoration: deco && deco.asset ? `https://cdn.discordapp.com/avatar-decoration-presets/${deco.asset}.png?size=256&passthrough=true` : null,
            banner: banner ? `https://cdn.discordapp.com/banners/${userId}/${banner}.${String(banner).startsWith("a_") ? "gif" : "png"}?size=1024` : null,
            banner_color: colorHex(up.accent_color ?? u.accent_color ?? u.accentColor) || u.banner_color || null,
            theme: Array.isArray(theme) && theme.length === 2 ? theme.map(colorHex) : null,
            tag: tag && (tag.tag || tag.identity_guild_id) ? { text: tag.tag || null, badge: tag.badge && (tag.identity_guild_id || tag.identityGuildId) ? `https://cdn.discordapp.com/clan-badges/${tag.identity_guild_id || tag.identityGuildId}/${tag.badge}.png?size=32` : null } : null,
            pronouns: up.pronouns || null,
            bio: up.bio || u.bio || "",
            status, custom, playing: typeof playing !== "undefined" ? playing : [],
            badges,
            member_since: created ? created.date : null,
            connections: (p.connected_accounts || []).map((c) => ({ type: c.type, label: CONNECTIONS[c.type] || c.type, name: c.name, verified: !!c.verified })),
            mutual_friends: p.mutual_friends_count ?? (p.mutual_friends || []).length ?? null,
            mutual_servers: (p.mutual_guilds || []).length || null,
            note: (() => { try { const N = store("NoteStore"); const n = N && N.getNote && N.getNote(userId); return (n && (n.note ?? n)) || null; } catch (_) { return null; } })(),
        };
    }

    // ------------------------------------------------------ friend requests
    function friendRequests() {
        const RS = store("RelationshipStore");
        if (!RS) throw new Error("Discord's friends list wasn't found");
        let rel = {};
        try { rel = RS.getMutableRelationships ? Object.fromEntries(RS.getMutableRelationships()) : RS.getRelationships(); } catch (_) {
            try { rel = RS.getRelationships(); } catch (_) { rel = {}; }
        }
        const out = { incoming: [], outgoing: [] };
        for (const [id, v] of Object.entries(rel || {})) {
            const type = typeof v === "object" && v ? v.type : v;
            if (type !== 3 && type !== 4) continue;
            const u = C().UserStore.getUser(id);
            const entry = { id, name: u ? (u.globalName || u.global_name || u.username) : id, username: u ? u.username : null, avatar: avatarUrl(u) };
            (type === 3 ? out.incoming : out.outgoing).push(entry);
        }
        return out;
    }
    async function friendRequest(action, userId, username) {
        const url = `/users/@me/relationships/${userId}`;
        if (action === "accept") await C().RestAPI.put({ url, body: {} });
        else if (action === "decline" || action === "cancel") await C().RestAPI.del({ url });
        else if (action === "send") {
            const name = String(username || "").trim().replace(/^@/, "");
            if (!name) throw new Error("Type a username first");
            await C().RestAPI.post({ url: "/users/@me/relationships", body: { username: name, discriminator: null } });
        } else throw new Error("unknown action");
        return { ok: true };
    }

    async function dmChannel(userId) {
        const CS = C().ChannelStore;
        let dm = CS.getDMFromUserId ? CS.getDMFromUserId(userId) : null;
        if (!dm) {
            const r = await C().RestAPI.post({ url: "/users/@me/channels", body: { recipients: [userId] } });
            dm = r && r.body && r.body.id;
            if (!dm) throw new Error("Couldn't open a DM with that friend");
            for (let i = 0; i < 30 && !CS.getChannel(dm); i++) await new Promise((r2) => setTimeout(r2, 100));
        }
        return dm;
    }

    // ------------------------------------------------------------ unreads
    function readState(channelId) {
        const R = store("ReadStateStore");
        let unread = 0, mentions = 0, has = false;
        try { has = !!(R && R.hasUnread && R.hasUnread(channelId)); } catch (_) { }
        try { mentions = (R && R.getMentionCount && R.getMentionCount(channelId)) || 0; } catch (_) { }
        try { unread = (R && R.getUnreadCount && R.getUnreadCount(channelId)) || 0; } catch (_) { }
        return { has: has || mentions > 0 || unread > 0, unread: Math.max(unread, mentions, has ? 1 : 0), mentions };
    }
    function guildReadState(guildId) {
        const G = store("GuildReadStateStore");
        let has = false, mentions = 0;
        try { has = !!(G && G.hasUnread && G.hasUnread(guildId)); } catch (_) { }
        try { mentions = (G && G.getMentionCount && G.getMentionCount(guildId)) || 0; } catch (_) { }
        return { has: has || mentions > 0, mentions };
    }
    // Discord's own mutes (right-click > Mute in Discord).
    function discordMuted(guildId, channelId) {
        const S = store("UserGuildSettingsStore");
        if (!S) return false;
        try { if (guildId && S.isMuted && S.isMuted(guildId)) return true; } catch (_) { }
        try { if (S.isChannelMuted && S.isChannelMuted(guildId || null, channelId)) return true; } catch (_) { }
        return false;
    }
    function lastMessageId(channelId) {
        try { const R = store("ReadStateStore"); const id = R && R.lastMessageId && R.lastMessageId(channelId); if (id) return id; } catch (_) { }
        try { const ch = C().ChannelStore.getChannel(channelId); if (ch && (ch.lastMessageId || ch.last_message_id)) return ch.lastMessageId || ch.last_message_id; } catch (_) { }
        try { const list = store("MessageStore").getMessages(channelId).toArray(); if (list.length) return list[list.length - 1].id; } catch (_) { }
        return null;
    }
    // DMs with unread messages, plus the read state of the channels asked about.
    function unreads(channelIds) {
        const dms = [];
        try {
            const PS = store("PrivateChannelSortStore");
            for (const id of (PS && PS.getPrivateChannelIds ? PS.getPrivateChannelIds() : []).slice(0, 60)) {
                const r = readState(id);
                if (!r.has) continue;
                const ch = C().ChannelStore.getChannel(id);
                if (!ch) continue;
                let avatar = null, last = null;
                try {
                    if (!ch.name && ch.recipients && ch.recipients.length === 1) avatar = avatarUrl(C().UserStore.getUser(ch.recipients[0]));
                } catch (_) { }
                try {
                    const list = store("MessageStore").getMessages(id).toArray();
                    const msg = list[list.length - 1];
                    if (msg) {
                        const au = C().UserStore.getUser(msg.author.id) || msg.author;
                        last = { author: friendName(au) || userName(au), text: messageText(msg), time: msgTime(msg.timestamp) / 1000 };
                    }
                } catch (_) { }
                dms.push({ channel_id: id, label: channelLabel(ch), is_dm: true, avatar, unread: r.unread, mentions: r.mentions,
                    muted: discordMuted(null, id), last });
                if (dms.length >= 20) break;
            }
        } catch (e) { warn("unread DMs", e); }
        const channels = {};
        for (const id of channelIds || []) { try { channels[id] = readState(id); } catch (_) { } }
        let total = 0;
        for (const d of dms) if (!d.muted) total += d.unread;
        return { dms, channels, total };
    }
    // Mark channels (or a whole server) as read, the way Discord does.
    async function ack(channelIds, guildId) {
        let ids = (channelIds || []).slice();
        if (guildId) {
            try {
                const GCS = store("GuildChannelStore");
                const g = GCS && GCS.getChannels(guildId);
                for (const v of (g && g.SELECTABLE) || []) ids.push((v.channel || v).id);
            } catch (_) { }
            try { for (const c of Object.values(C().ChannelStore.getMutableGuildChannelsForGuild(guildId) || {})) ids.push(c.id); } catch (_) { }
        }
        ids = [...new Set(ids)].filter((id) => readState(id).has);
        const states = ids.map((id) => ({ channel_id: id, message_id: lastMessageId(id), read_state_type: 0 })).filter((s) => s.message_id);
        for (let i = 0; i < states.length; i += 100) {
            await C().RestAPI.post({ url: "/read-states/ack-bulk", body: { read_states: states.slice(i, i + 100) } });
        }
        return { ok: true, acked: states.length };
    }

    function textChannels(guildId) {
        let list = [];
        try {
            const GCS = store("GuildChannelStore");
            const sel = GCS && GCS.getChannels(guildId) && GCS.getChannels(guildId).SELECTABLE;
            if (sel) list = sel.map((v) => v.channel || v).filter((c) => c && (c.type === 0 || c.type === 5));
        } catch (_) { }
        if (!list.length) {
            const all = C().ChannelStore.getMutableGuildChannelsForGuild(guildId) || {};
            list = Object.values(all).filter((c) => c.type === 0 || c.type === 5)
                .sort((a, b) => (a.position || 0) - (b.position || 0));
        }
        return list.map((c) => {
            const r = readState(c.id);
            return { id: c.id, name: c.name, unread: r.has, mentions: r.mentions, muted: discordMuted(guildId, c.id) };
        });
    }

    async function callFriend(userId) {
        const dm = await dmChannel(userId);
        const method = selectVoice(null, dm);
        try { await C().RestAPI.post({ url: `/channels/${dm}/call/ring`, body: { recipients: null } }); } catch (_) { }
        return { ok: true, method };
    }

    // --------------------------------------------------------- human check
    // Discord sometimes asks "are you human?" (hCaptcha), e.g. after Go Live
    // or a call started from Discordio. In the hidden view nobody would see
    // it, so tell the QAM, which points you to Discord to finish it.
    let captcha = false;
    function captchaShown() {
        if (document.querySelector('iframe[src*="hcaptcha"], iframe[src*="captcha"], iframe[title*="captcha" i]')) return true;
        for (const d of document.querySelectorAll("[role=dialog]")) {
            if (/are you human|captcha|verify (that )?you/i.test(d.textContent || "")) return true;
        }
        return false;
    }
    function watchCaptcha() {
        const check = () => {
            const now = captchaShown();
            if (now === captcha) return;
            captcha = now;
            log(now ? "Discord is asking for a human check (captcha)" : "human check finished");
            emit("captcha", { active: now });
        };
        let pending = false;
        const mo = new MutationObserver(() => {
            if (pending) return;
            pending = true;
            setTimeout(() => { pending = false; check(); }, 300);
        });
        const start = () => mo.observe(document.body, { childList: true, subtree: true });
        if (document.body) start(); else addEventListener("DOMContentLoaded", start);
    }

    // ------------------------------------------------ people in your call
    // Moderation needs the matching permission in that channel; DM calls
    // have none of these.
    function modPermissions(ch) {
        const out = { mute: false, deafen: false, move: false };
        if (!ch || !ch.guild_id) return out;
        try {
            const P = C().PermissionStore || store("PermissionStore");
            const B = C().PermissionsBits || {};
            const can = (bit, fallback) => !!(P && P.can && P.can(bit !== undefined ? bit : fallback, ch));
            out.mute = can(B.MUTE_MEMBERS, 1n << 22n);
            out.deafen = can(B.DEAFEN_MEMBERS, 1n << 23n);
            out.move = can(B.MOVE_MEMBERS, 1n << 24n);
        } catch (e) { warn("permissions", e); }
        return out;
    }

    function setLocalMute(userId, muted) {
        const M = store("MediaEngineStore");
        const now = !!(M && M.isLocalMute && M.isLocalMute(userId, "default"));
        if (now === !!muted) return { ok: true };
        const a = props("toggleLocalMute");
        if (a && a.toggleLocalMute) a.toggleLocalMute(userId, "default");
        else dispatch({ type: "AUDIO_TOGGLE_LOCAL_MUTE", context: "default", userId });
        return { ok: true };
    }

    function setUserVolume(userId, volume) {
        const v = Math.max(0, Math.min(200, Number(volume) || 0));
        const a = props("setLocalVolume");
        if (a && a.setLocalVolume) a.setLocalVolume(userId, v, "default");
        else dispatch({ type: "AUDIO_SET_LOCAL_VOLUME", context: "default", userId, volume: v });
        return { ok: true, volume: v };
    }

    // Server mute / deafen / disconnect: the same request Discord's own
    // right-click menu sends. Discord refuses it without the permission.
    async function moderate(userId, action, value) {
        const vc = voiceChannelId();
        const ch = vc && C().ChannelStore.getChannel(vc);
        if (!ch || !ch.guild_id) throw new Error("That only works in a server voice channel");
        const body = action === "mute" ? { mute: !!value }
            : action === "deafen" ? { deaf: !!value }
            : action === "disconnect" ? { channel_id: null }
            : null;
        if (!body) throw new Error("Unknown action " + action);
        try {
            await C().RestAPI.patch({ url: `/guilds/${ch.guild_id}/members/${userId}`, body });
        } catch (e) {
            const status = e && (e.status || (e.body && e.body.code));
            if (e && e.status === 403) throw new Error("You don't have permission to do that in this server");
            throw new Error((e && e.body && e.body.message) || `Discord refused (${status || e})`);
        }
        return { ok: true };
    }

    // ------------------------------------------------------------- account
    function accounts() {
        const u = me();
        let saved = [];
        try {
            const MA = store("MultiAccountStore");
            saved = ((MA && MA.getUsers && MA.getUsers()) || []).map((a) => ({
                id: a.id, name: a.globalName || a.global_name || a.username,
                avatar: a.avatar ? `https://cdn.discordapp.com/avatars/${a.id}/${a.avatar}.webp?size=64` : null,
                current: !!(u && a.id === u.id), valid: a.tokenStatus !== 2,
            }));
        } catch (_) { }
        return {
            me: u ? { id: u.id, name: userName(u), avatar: avatarUrl(u) } : null,
            saved,
            canSwitch: !!props("switchAccount"),
        };
    }

    async function switchAccount(userId) {
        const a = props("switchAccount");
        if (!a || !a.switchAccount) throw new Error("Discord's account switcher wasn't found; switch accounts inside Discord");
        await a.switchAccount(userId);
        return { ok: true };
    }

    async function logout() {
        const a = props("logout", "login");
        try {
            if (a && a.logout) { await a.logout(); return { ok: true, method: "action" }; }
        } catch (e) { warn("logout action", e); }
        try { await C().RestAPI.post({ url: "/auth/logout", body: { provider: null, voip_provider: null } }); } catch (_) { }
        try { dispatch({ type: "LOGOUT" }); } catch (_) { }
        setTimeout(() => { location.href = "/login"; }, 300);
        return { ok: true, method: "rest" };
    }

    // ------------------------------------------------------- incoming calls
    // Discord announces a call with CALL_CREATE / CALL_UPDATE, whose
    // "ringing" list holds the users being rung, and ends it with
    // CALL_DELETE (or an update that no longer rings us).
    let incoming = null; // { channel_id, caller, ... } while we're being rung

    // The name you know them by: your friend nickname for them if you set
    // one, else their display name.
    function friendName(user) {
        if (!user) return null;
        try {
            const R = store("RelationshipStore");
            const nick = R && R.getNickname && R.getNickname(user.id);
            if (nick) return nick;
        } catch (_) { }
        return userName(user);
    }

    function callerFor(ch, ringerId) {
        const u = me();
        const id = ringerId || ((ch && ch.recipients) || []).find((r) => !u || r !== u.id);
        const user = id ? C().UserStore.getUser(id) : null;
        return { id: id || null, name: friendName(user) || channelLabel(ch) || "Someone", avatar: avatarUrl(user) };
    }

    let callLogs = 0;
    // The ringtone while someone calls you (Discord's own sound; its page is
    // hidden, so it didn't play it by itself). Not in Do Not Disturb.
    let ringtone = null;
    function ringStart() {
        if (ringtone) return;
        try { const st = myStatus(); if (st && st.status === "dnd") return; } catch (_) { }
        try {
            const P = props("playSound", "createSound");
            if (!P || !P.createSound) { warn("ringtone: Discord's sound player wasn't found"); return; }
            const s = P.createSound("call_ringing", "call_ringing", 0.7);
            ringtone = s;
            if (s.loop) s.loop(); else if (s.play) s.play();
        } catch (e) { warn("ringtone", e); ringtone = null; }
    }
    function ringStop() {
        const s = ringtone;
        ringtone = null;
        try { s && s.stop && s.stop(); } catch (_) { }
    }

    function onCall(e) {
        try {
            const u = me();
            if (!u) return;
            const call = e.call || e;
            const cid = call.channelId || call.channel_id || e.channelId || e.channel_id;
            if (!cid) return;
            const ringing = (call.ringing || e.ringing || []).map((x) => String((x && (x.id || x.userId)) || x));
            if (callLogs < 20 && e.type !== "POLL") {
                callLogs++;
                log(`call event ${e.type}: channel ${cid}, ringing ${ringing.length ? (ringing.includes(u.id) ? "you" : ringing.length + " others") : "nobody"}`);
            }
            // On this Discord, CALL_CREATE / CALL_UPDATE arrive with an empty
            // ringing list even while you're being rung, so an empty list
            // means "unknown", not "stopped". Rings end on CALL_DELETE,
            // joining, answer / decline, someone else being rung instead, or
            // Discord's ring timeout.
            if (e.type !== "CALL_DELETE" && !ringing.length && incoming && incoming.channel_id === cid) return;
            const ringingMe = e.type !== "CALL_DELETE" && ringing.includes(String(u.id)) && voiceChannelId() !== cid;
            if (ringingMe && (!incoming || incoming.channel_id !== cid)) {
                const ch = C().ChannelStore.getChannel(cid);
                const isGroup = ch && (ch.recipients || []).length > 1;
                incoming = {
                    channel_id: cid,
                    caller: callerFor(ch, e.ringer || null),
                    group: isGroup ? channelLabel(ch) : null,
                    since: Date.now(),
                };
                log(`incoming call from ${incoming.caller.name}`);
                ringStart();
                emit("call_incoming", incoming);
            } else if (!ringingMe && incoming && incoming.channel_id === cid) {
                const answered = voiceChannelId() === cid;
                incoming = null;
                ringStop();
                emit("call_ended", { channel_id: cid, answered });
            }
        } catch (err) { warn("call event", err); }
    }

    function answerCall(channelId) {
        const cid = channelId || (incoming && incoming.channel_id);
        if (!cid) throw new Error("No call is ringing");
        const method = selectVoice(null, cid);
        if (incoming && incoming.channel_id === cid) {
            incoming = null;
            emit("call_ended", { channel_id: cid, answered: true });
        }
        return { ok: true, method };
    }

    async function declineCall(channelId) {
        const cid = channelId || (incoming && incoming.channel_id);
        if (!cid) throw new Error("No call is ringing");
        const u = me();
        // Same as Discord's Decline button: stop ringing just for us.
        try {
            const a = props("stopRinging", "ring");
            if (a && a.stopRinging) await a.stopRinging(cid, [u.id]);
            else throw new Error("no action");
        } catch (_) {
            await C().RestAPI.post({ url: `/channels/${cid}/call/stop-ringing`, body: { recipients: [u.id] } });
        }
        if (incoming && incoming.channel_id === cid) {
            incoming = null;
            emit("call_ended", { channel_id: cid, answered: false });
        }
        return { ok: true };
    }

    // ------------------------------------------------------------------ audio
    function audioDevices() {
        const M = store("MediaEngineStore");
        if (!M) throw new Error("Discord's audio settings weren't found");
        const outs = Object.values(M.getOutputDevices() || {}).map((d) => ({ id: d.id, name: d.name || "Output" }));
        return { outputs: outs, output: M.getOutputDeviceId() };
    }

    // ----------------------------------------------------------------- methods
    const m = window.DISCORDIO.method;
    m("ping", () => ({ pong: true, ready, at: Date.now() }));
    m("getState", () => buildState());
    m("toggleMute", () => toggle("toggleSelfMute", "AUDIO_TOGGLE_SELF_MUTE"));
    m("toggleDeafen", () => toggle("toggleSelfDeaf", "AUDIO_TOGGLE_SELF_DEAF"));
    m("disconnect", () => ({ ok: true, method: selectVoice(null, null) }));
    m("join", ({ channelId }) => {
        const ch = C().ChannelStore.getChannel(channelId);
        if (!ch) throw new Error("That channel wasn't found");
        return { ok: true, method: selectVoice(ch.guild_id || null, channelId) };
    });
    m("callFriend", ({ userId }) => callFriend(userId));
    m("incomingCall", () => incoming);
    m("emojis", ({ channelId }) => emojis(channelId));
    m("react", ({ channelId, messageId, emoji, remove }) => react(channelId, messageId, emoji, !!remove));
    m("watchStream", ({ userId, overlay, fps, player }) => watchStream(userId, !!overlay, fps, !!player));
    m("pipFps", ({ fps }) => pipFps(fps));
    m("stopWatching", () => stopWatching());
    m("pipStop", () => pipStop());
    m("hidePlayer", () => { hidePlayer(); return { ok: true }; });
    m("getStatus", () => myStatus());
    m("setStatus", ({ status, custom, emoji, clearAfter }) => setStatus(status, custom, emoji, clearAfter));
    m("setLocalMute", ({ userId, muted }) => setLocalMute(userId, muted));
    m("setUserVolume", ({ userId, volume }) => setUserVolume(userId, volume));
    m("moderate", ({ userId, action, value }) => moderate(userId, action, value));
    m("accounts", () => accounts());
    m("switchAccount", ({ userId }) => switchAccount(userId));
    m("logout", () => logout());
    m("openDm", async ({ userId }) => {
        const id = await dmChannel(userId);
        const ch = C().ChannelStore.getChannel(id);
        return { channel_id: id, label: channelLabel(ch) };
    });
    m("callChannel", async ({ channelId }) => {
        const method = selectVoice(null, channelId);
        try { await C().RestAPI.post({ url: `/channels/${channelId}/call/ring`, body: { recipients: null } }); } catch (_) { }
        return { ok: true, method };
    });
    m("answerCall", ({ channelId }) => { ringStop(); return answerCall(channelId); });
    m("declineCall", ({ channelId }) => { ringStop(); return declineCall(channelId); });
    // After the backend unlocks sound (if the first try was blocked).
    m("ringAgain", () => { if (incoming) { ringStop(); ringStart(); } return { ok: true, ringing: !!ringtone }; });
    m("guilds", () => guilds());
    m("badges", () => myBadges());
    m("profile", ({ userId }) => userProfile(userId));
    m("editMessage", ({ channelId, messageId, content }) => editMessage(channelId, messageId, content));
    m("deleteMessage", ({ channelId, messageId }) => deleteMessage(channelId, messageId));
    m("friendRequests", () => friendRequests());
    m("friendRequest", ({ action, userId, username }) => friendRequest(action, userId, username));
    m("unreads", ({ channelIds }) => unreads(channelIds));
    m("ack", ({ channelIds, guildId }) => ack(channelIds, guildId));
    m("voiceChannels", ({ guildId }) => voiceChannels(guildId));
    m("friends", () => friends());
    m("voice", () => voiceInfo());
    m("setPtt", ({ down }) => {
        const M = store("MediaEngineStore");
        const conns = M.getMediaEngine().connections;
        for (const c of conns.values ? conns.values() : Object.values(conns)) {
            try { c.setForceAudioInput(!!down); } catch (_) { }
        }
        return { ok: true };
    });
    m("enablePtt", ({ enabled }) => {
        const M = store("MediaEngineStore");
        dispatch({
            type: "AUDIO_SET_MODE", context: "default",
            mode: enabled ? "PUSH_TO_TALK" : "VOICE_ACTIVITY",
            options: M.getSettings().modeOptions,
        });
        return { ok: true };
    });
    // Voice activity sensitivity (Discord's "Input Sensitivity").
    m("voiceMode", () => {
        const s = store("MediaEngineStore").getSettings();
        const o = s.modeOptions || {};
        return { mode: s.mode, autoThreshold: o.autoThreshold !== false, threshold: typeof o.threshold === "number" ? o.threshold : -60 };
    });
    m("setSensitivity", ({ auto, threshold }) => {
        const s = store("MediaEngineStore").getSettings();
        const options = { ...(s.modeOptions || {}), autoThreshold: !!auto };
        if (typeof threshold === "number") options.threshold = Math.max(-100, Math.min(0, threshold));
        dispatch({ type: "AUDIO_SET_MODE", context: "default", mode: s.mode || "VOICE_ACTIVITY", options });
        return { ok: true };
    });
    m("setActivity", ({ game }) => setActivity(game));
    m("recentChannels", () => recentTextChannels());
    m("postScreenshot", async ({ channelId, userId, data, filename }) =>
        postScreenshot(channelId || await dmChannel(userId), data, filename));
    m("textChannels", ({ guildId }) => textChannels(guildId));
    m("history", ({ channelId, limit }) => history(channelId, limit));
    m("sendMessage", ({ channelId, userId, content, replyTo }) =>
        (channelId ? Promise.resolve(channelId) : dmChannel(userId)).then((id) => sendMessage(id, content, replyTo)));
    m("gifs", ({ query }) => gifs(query));
    m("goLive", ({ quality, uiOnly }) => goLive(false, quality, !!uiOnly));
    m("pageVisible", () => ({ visible: document.visibilityState === "visible", info: pageInfo() }));
    m("stopLive", () => goLive(true));
    m("streamLimits", () => streamLimits());
    m("audioDevices", () => audioDevices());
    m("setOutput", ({ id }) => { dispatch({ type: "AUDIO_SET_OUTPUT_DEVICE", id }); return audioDevices(); });
    m("nav", ({ action }) => (window.DISCORDIO_NAV ? window.DISCORDIO_NAV(action) : { handled: false, error: "navigator not loaded" }));
    m("selfTest", () => {
        // Checks every Discord internal Discordio relies on.
        const checks = {
            FluxDispatcher: !!C().FluxDispatcher, UserStore: !!C().UserStore, ChannelStore: !!C().ChannelStore,
            GuildStore: !!(C().GuildStore || store("GuildStore")), RestAPI: !!C().RestAPI,
        };
        for (const s of ["SelectedChannelStore", "VoiceStateStore", "MediaEngineStore", "RelationshipStore",
            "PresenceStore", "GuildChannelStore", "SortedGuildStore", "ApplicationStreamingStore"]) checks[s] = !!store(s);
        checks.selectVoiceChannel = !!props("selectVoiceChannel");
        checks.loggedIn = !!me();
        return checks;
    });

    // ------------------------------------------------------------------ events
    const STATE_EVENTS = [
        "CONNECTION_OPEN", "LOGOUT", "CONNECTION_CLOSED", "VOICE_STATE_UPDATES", "VOICE_CHANNEL_SELECT",
        "AUDIO_TOGGLE_SELF_MUTE", "AUDIO_TOGGLE_SELF_DEAF", "AUDIO_SET_SELF_MUTE", "STREAM_START", "STREAM_STOP",
        "STREAM_CREATE", "STREAM_DELETE", "STREAM_UPDATE", "RTC_CONNECTION_STATE", "USER_UPDATE",
    ];

    function channelLabel(ch) {
        if (!ch) return "";
        if (!ch.guild_id) {
            const names = (ch.recipients || []).map((r) => userName(C().UserStore.getUser(r)));
            return ch.name || (names.length > 1 ? names.join(", ") : "Direct message");
        }
        const g = C().GuildStore.getGuild(ch.guild_id);
        return `#${ch.name}${g ? " in " + g.name : ""}`;
    }

    function messageText(msg) {
        let text = msg.content || "";
        // Mentions show as names, not <@id>.
        text = text.replace(/<@!?(\d+)>/g, (_, id) => "@" + userName(C().UserStore.getUser(id)));
        text = text.replace(/<#(\d+)>/g, (_, id) => { const c = C().ChannelStore.getChannel(id); return c ? "#" + c.name : "#channel"; });
        text = text.replace(/<a?:(\w+):\d+>/g, ":$1:");
        if (!text && msg.attachments && msg.attachments.length) text = `[${msg.attachments.length > 1 ? msg.attachments.length + " attachments" : "attachment"}]`;
        if (!text && msg.embeds && msg.embeds.length) text = "[embed]";
        if (!text && msg.sticker_items && msg.sticker_items.length) text = "[sticker]";
        return text;
    }

    // REST messages have ISO strings, Discord's store has moment/Date objects.
    function msgTime(t) {
        if (!t) return Date.now();
        if (typeof t === "string") return Date.parse(t) || Date.now();
        return Number(t) || Date.now();
    }

    // Images, GIFs, videos and stickers in a message, for the QAM to show.
    // REST data is snake_case; Discord's message store uses camelCase.
    function mediaOf(msg) {
        const out = [];
        const src = (o) => o && (o.proxy_url || o.proxyURL || o.url);
        for (const a of msg.attachments || []) {
            const ct = a.content_type || a.contentType || "";
            const name = a.filename || "";
            const kind = /gif/.test(ct) || /\.gif$/i.test(name) ? "gif"
                : ct.startsWith("image/") || /\.(png|jpe?g|webp|avif)$/i.test(name) ? "image"
                : ct.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(name) ? "video" : "file";
            out.push({ kind, url: src(a), name, width: a.width || null, height: a.height || null });
        }
        for (const e of msg.embeds || []) {
            const thumb = src(e.thumbnail);
            if ((e.type === "gifv" || e.type === "gif") && e.video) out.push({ kind: "gifv", url: src(e.video), poster: thumb, link: e.url });
            else if (e.type === "image" && (e.image || e.thumbnail)) out.push({ kind: "image", url: src(e.image) || thumb, link: e.url });
            else if (e.type === "video" && e.video && /\.(mp4|webm)(\?|$)/i.test(src(e.video) || "")) out.push({ kind: "video", url: src(e.video), poster: thumb });
            else if (e.image) out.push({ kind: "image", url: src(e.image), link: e.url, title: e.title || null });
            else if (thumb) out.push({ kind: "image", url: thumb, link: e.url, title: e.title || null });
        }
        for (const st of msg.sticker_items || msg.stickerItems || msg.stickers || []) {
            const fmt = st.format_type || st.formatType;
            if (fmt === 3) { out.push({ kind: "file", name: `sticker: ${st.name}` }); continue; } // Lottie
            out.push({ kind: "sticker", url: `https://media.discordapp.net/stickers/${st.id}.${fmt === 4 ? "gif" : "png"}?size=160`, name: st.name });
        }
        return out.filter((m) => m.url || m.kind === "file").slice(0, 4);
    }

    function simplifyMessage(msg) {
        const a = msg.author || {};
        const u = C().UserStore.getUser(a.id) || a;
        const media = mediaOf(msg);
        let text = messageText(msg);
        // A message that is just a GIF / image link shows the picture instead.
        if (media.length && media.some((m) => m.link && text.trim() === m.link)) text = "";
        if (media.length && /^\[(attachment|\d+ attachments|embed|sticker)\]$/.test(text)) text = "";
        const reactions = (msg.reactions || []).slice(0, 8).map((r) => {
            const e = r.emoji || {};
            return {
                emoji: e.id ? null : e.name, name: e.name, id: e.id || null,
                url: e.id ? `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? "gif" : "png"}?size=32` : null,
                count: r.count || (r.count_details ? (r.count_details.normal || 0) + (r.count_details.burst || 0) : 1),
                me: !!r.me,
            };
        });
        // The message this one replies to, as a one-line quote.
        let replyTo = null;
        const ref = msg.messageReference || msg.message_reference;
        if (ref && ref.message_id) {
            let r = msg.referencedMessage || msg.referenced_message || null;
            if (r && r.message) r = r.message; // Discord wraps it as { state, message }
            if (!r || !r.author) { try { r = store("MessageStore").getMessage(ref.channel_id || msg.channel_id, ref.message_id); } catch (_) { r = null; } }
            if (r && r.author) {
                const ru = C().UserStore.getUser(r.author.id) || r.author;
                const t = messageText(r) || "(attachment)";
                replyTo = { id: r.id, name: friendName(ru) || userName(ru), text: t.length > 80 ? t.slice(0, 79) + "…" : t };
            } else replyTo = { id: ref.message_id, name: null, text: "Original message not loaded" };
        }
        return {
            id: msg.id, channel_id: msg.channel_id,
            author: { id: a.id, name: friendName(u) || userName(u), avatar: avatarUrl(u) },
            text, media, reactions, replyTo, edited: !!(msg.editedTimestamp || msg.edited_timestamp),
            time: msgTime(msg.timestamp),
            mine: !!(me() && a.id === me().id),
        };
    }

    function onMessage(e) {
        try {
            const msg = e.message;
            const u = me();
            if (!msg || !u || !msg.author || msg.author.id === u.id || e.optimistic) return;
            if (msg.type === 3) {
                // Discord's "started a call" message: a ring, not a message.
                const ended = msg.call && msg.call.ended_timestamp;
                if (!ended && voiceChannelId() !== msg.channel_id) {
                    onCall({ type: "CALL_MESSAGE", channelId: msg.channel_id, ringing: [u.id], ringer: msg.author.id });
                }
                return;
            }
            const ch = C().ChannelStore.getChannel(msg.channel_id);
            const isDM = ch && !ch.guild_id;
            const mentioned = (msg.mentions || []).some((x) => (x.id || x) === u.id) || !!msg.mention_everyone;
            if (!isDM && !mentioned) return;
            const m = simplifyMessage(msg);
            // Popups have no room for pictures: say what was sent.
            const label = (m.media || []).map((x) => ({ gif: "GIF", gifv: "GIF", image: "image", video: "video", sticker: "sticker" })[x.kind] || "file");
            const text = m.text || (label.length ? `[${label[0]}${label.length > 1 ? ` +${label.length - 1}` : ""}]` : "");
            const guild = ch && ch.guild_id ? C().GuildStore.getGuild(ch.guild_id) : null;
            emit("message", { ...m, text, channel_label: channelLabel(ch), is_dm: !!isDM, mentioned,
                guild_id: guild ? guild.id : null, guild_name: guild ? guild.name : null,
                discord_muted: discordMuted(ch && ch.guild_id, msg.channel_id) });
        } catch (err) { warn("message event", err); }
    }

    // Who's typing in a channel right now (not you).
    function typingIn(channelId) {
        try {
            const T = store("TypingStore");
            const ids = Object.keys((T && T.getTypingUsers && T.getTypingUsers(channelId)) || {});
            const u = me();
            return ids.filter((id) => !u || id !== u.id)
                .map((id) => friendName(C().UserStore.getUser(id)) || "Someone").slice(0, 3);
        } catch (_) { return []; }
    }

    // ------------------------------------------------------------- GIFs
    // Discord's own GIF picker: your favorites, trending, and search (Tenor
    // through Discord's API). Sending one posts its link, as Discord does.
    // Recent emojis and favorite GIFs live in Discord's "frecency" settings,
    // which it only downloads when its own picker opens (e.g. not yet after
    // logging in again). Ask for them first.
    let frecencyAsked = 0;
    async function ensureFrecency() {
        if (Date.now() - frecencyAsked < 60000) return;
        frecencyAsked = Date.now();
        try {
            const A = C().UserSettingsActionCreators || props("FrecencyUserSettingsActionCreators");
            const F = A && (A.FrecencyUserSettingsActionCreators || (A.loadIfNecessary ? A : null));
            if (F && F.loadIfNecessary) await Promise.race([Promise.resolve(F.loadIfNecessary()), sleep(4000)]);
            else warn("frecency settings loader not found");
        } catch (e) { warn("frecency settings", e); }
    }
    function frecencySettings() {
        try {
            const A = C().UserSettingsActionCreators || props("FrecencyUserSettingsActionCreators");
            const F = A && (A.FrecencyUserSettingsActionCreators || A);
            const v = F && F.getCurrentValue && F.getCurrentValue();
            if (v) return v;
        } catch (_) { }
        try { const P = store("UserSettingsProtoStore"); return P && P.frecencyWithoutFetchingLatest; } catch (_) { return null; }
    }
    function favoriteGifs() {
        try {
            const f = frecencySettings();
            const g = f && f.favoriteGifs;
            const map = (g && g.gifs) || {};
            return Object.entries(map)
                .map(([url, v]) => ({ url, src: v.src, width: v.width, height: v.height, order: v.order || 0, video: v.format === 2 || /\.mp4|\.webm/.test(v.src || "") }))
                .filter((x) => x.src)
                .sort((a, b) => b.order - a.order);
        } catch (_) { return []; }
    }
    const gifOut = (g) => {
        const src = g.src || g.gif_src;
        return src ? { url: g.url, src, width: g.width, height: g.height, video: /\.mp4|\.webm/.test(src) } : null;
    };
    async function gifs(query) {
        if (!query) await ensureFrecency();
        const locale = (navigator.language || "en-US");
        if (query) {
            const r = await C().RestAPI.get({ url: "/gifs/search", query: { q: query, provider: "tenor", media_format: "mp4", locale, limit: 40 } });
            return { gifs: (r.body || []).map(gifOut).filter(Boolean) };
        }
        // Favorites only: Discord's trending picks just took up space.
        return { favorites: favoriteGifs() };
    }

    // ----------------------------------------------------------- emojis
    const emojiUrl = (id, animated) => `https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "webp"}?size=48&quality=lossless`;
    function emojiOut(e) {
        if (!e) return null;
        if (e.id) {
            if (e.available === false) return null;
            return { id: String(e.id), name: e.name, animated: !!e.animated, guild: e.guildId ? String(e.guildId) : null, url: emojiUrl(e.id, e.animated) };
        }
        const s = e.surrogates || e.optionallyDiverseSequence;
        return s ? { id: null, name: s, emoji: s } : null;
    }
    // Which emojis the user can react with, the way Discord's picker does:
    // recent and favorites first, then every server's own emojis. Without
    // Nitro, custom emojis only work in their own server and can't be animated.
    async function emojis(channelId) {
        await ensureFrecency();
        const E = store("EmojiStore");
        if (!E) throw new Error("Discord's emoji list wasn't found");
        const u = me();
        const nitro = !!(u && (u.premiumType ?? 0) > 0);
        let here = null;
        try { here = channelId ? (C().ChannelStore.getChannel(channelId) || {}).guild_id || null : null; } catch (_) { }
        const usable = (e) => e && (!e.id || nitro || (e.guild && e.guild === here && !e.animated));
        const uniq = (list) => {
            const seen = new Set();
            return list.filter((e) => { const k = e.id || e.name; if (!e || seen.has(k)) return false; seen.add(k); return true; });
        };

        let recent = [];
        try {
            const f = E.emojiFrecencyWithoutFetchingLatest;
            recent = ((f && (f.frequently || (f.getFrequentlyWithoutFetchingLatest && f.getFrequentlyWithoutFetchingLatest()))) || []).map(emojiOut);
        } catch (_) { }
        // Straight from the settings, if the store hasn't worked it out yet.
        if (!recent.filter(Boolean).length) {
            try {
                const f = frecencySettings();
                const map = (f && f.emojiFrecency && f.emojiFrecency.emojis) || {};
                const U = props("getByName", "convertNameToSurrogate") || props("getByName");
                recent = Object.entries(map)
                    .sort((a, b) => ((b[1] && (b[1].score || b[1].frecency || b[1].totalUses)) || 0) - ((a[1] && (a[1].score || a[1].frecency || a[1].totalUses)) || 0))
                    .slice(0, 40)
                    .map(([k]) => {
                        try { return emojiOut(/^\d+$/.test(k) ? E.getCustomEmojiById(k) : U && U.getByName(k)); } catch (_) { return null; }
                    });
            } catch (e) { warn("recent emojis", e); }
        }

        let favorites = [];
        try {
            const f = frecencySettings();
            const names = (f && f.favoriteEmojis && f.favoriteEmojis.emojis) || [];
            const U = props("getByName", "convertNameToSurrogate") || props("getByName");
            favorites = names.map((n) => {
                if (/^\d+$/.test(n)) {
                    try { return emojiOut(E.getCustomEmojiById(n)); } catch (_) { return null; }
                }
                try { return emojiOut(U && U.getByName(n)); } catch (_) { return null; }
            });
        } catch (_) { }

        const servers = [];
        for (const g of (() => { try { return guilds(); } catch (_) { return []; } })()) {
            let list = [];
            try { list = E.getGuildEmoji(g.id) || []; } catch (_) { }
            const out = list.map((e) => emojiOut({ ...e, id: e.id, name: e.name, animated: e.animated, available: e.available, guildId: g.id }))
                .filter(usable);
            if (out.length) servers.push({ id: g.id, name: g.name, icon: g.icon, emojis: out });
        }
        // The current server's emojis first.
        servers.sort((a, b) => (b.id === here) - (a.id === here));
        return {
            nitro,
            recent: uniq(recent.filter(usable)).slice(0, 24),
            favorites: uniq(favorites.filter(usable)),
            servers,
        };
    }

    // Add / remove a reaction: Discord's action, or the same request it sends.
    // emoji is a unicode emoji, or { id, name, animated } for a custom one.
    async function react(channelId, messageId, emoji, remove) {
        const a = props("addReaction", "removeReaction");
        const e = typeof emoji === "object" && emoji && emoji.id
            ? { id: String(emoji.id), name: emoji.name, animated: !!emoji.animated }
            : { id: null, name: typeof emoji === "object" && emoji ? emoji.name : emoji, animated: false };
        try {
            if (a && (remove ? a.removeReaction : a.addReaction)) {
                await (remove ? a.removeReaction(channelId, messageId, e) : a.addReaction(channelId, messageId, e));
                return { ok: true, method: "action" };
            }
        } catch (err) { warn("reaction action", err); }
        const key = e.id ? `${e.name}:${e.id}` : e.name;
        const url = `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(key)}/@me`;
        if (remove) await C().RestAPI.del({ url }); else await C().RestAPI.put({ url });
        return { ok: true, method: "rest" };
    }

    // Read from Discord's own message store, which updates the instant a
    // message arrives or is sent; fall back to the REST API (and ask Discord
    // to load the channel) the first time a channel is opened.
    async function history(channelId, limit) {
        limit = limit || 25;
        const ch = C().ChannelStore.getChannel(channelId);
        const MS = store("MessageStore");
        let local = null;
        try { local = MS && MS.getMessages(channelId); } catch (_) { }
        const arr = local && typeof local.toArray === "function" ? local.toArray() : [];
        if (arr.length) {
            return { channel_id: channelId, label: channelLabel(ch), source: "live",
                     messages: arr.slice(-limit).map(simplifyMessage), typing: typingIn(channelId) };
        }
        try {
            const actions = props("fetchMessages", "sendMessage");
            if (actions) actions.fetchMessages({ channelId, limit: 50 });
        } catch (_) { }
        const r = await C().RestAPI.get({ url: `/channels/${channelId}/messages`, query: { limit } });
        const list = (r && r.body) || [];
        return { channel_id: channelId, label: channelLabel(ch), source: "rest", messages: list.map(simplifyMessage).reverse() };
    }

    function nonce() {
        try {
            const S = C().SnowflakeUtils;
            if (S && S.fromTimestamp) return String(S.fromTimestamp(Date.now()));
        } catch (_) { }
        // Same shape as a Discord snowflake: ms since 2015 shifted left 22 bits.
        return String((BigInt(Date.now() - 1420070400000) << 22n) + BigInt(Math.floor(Math.random() * 4096)));
    }

    async function sendMessage(channelId, content, replyTo) {
        content = String(content || "").trim();
        let ref = null;
        if (replyTo) {
            let guild = null;
            try { guild = (C().ChannelStore.getChannel(channelId) || {}).guild_id || null; } catch (_) { }
            ref = { guild_id: guild || undefined, channel_id: channelId, message_id: String(replyTo) };
        }
        if (!content) throw new Error("Nothing to send");
        if (content.length > 2000) throw new Error("Discord messages can be at most 2000 characters");
        const actions = props("sendMessage", "editMessage");
        if (actions && actions.sendMessage) {
            try {
                // Newer Discord reads a 4th "options" argument (nonce etc.);
                // leaving it out was the "reading 'nonce'" error.
                await actions.sendMessage(channelId,
                    { content, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] },
                    undefined, ref
                        ? { nonce: nonce(), messageReference: ref, allowedMentions: { parse: ["users", "roles", "everyone"], replied_user: true } }
                        : { nonce: nonce() });
                return { ok: true, method: "action" };
            } catch (e) {
                warn("sendMessage action failed, using the REST API:", e);
            }
        }
        await C().RestAPI.post({ url: `/channels/${channelId}/messages`, body: { content, nonce: nonce(), tts: false, ...(ref ? { message_reference: ref } : {}) } });
        return { ok: true, method: "rest" };
    }

    // Edit / delete one of your own messages.
    async function editMessage(channelId, messageId, content) {
        content = String(content || "").trim();
        if (!content) throw new Error("A message can't be empty (delete it instead)");
        if (content.length > 2000) throw new Error("Discord messages can be at most 2000 characters");
        const a = props("editMessage", "sendMessage");
        try {
            if (a && a.editMessage) { await a.editMessage(channelId, messageId, { content }); return { ok: true, method: "action" }; }
        } catch (e) { warn("editMessage action", e); }
        await C().RestAPI.patch({ url: `/channels/${channelId}/messages/${messageId}`, body: { content } });
        return { ok: true, method: "rest" };
    }
    async function deleteMessage(channelId, messageId) {
        const a = props("deleteMessage", "sendMessage");
        try {
            if (a && a.deleteMessage) { await a.deleteMessage(channelId, messageId); return { ok: true, method: "action" }; }
        } catch (e) { warn("deleteMessage action", e); }
        await C().RestAPI.del({ url: `/channels/${channelId}/messages/${messageId}` });
        return { ok: true, method: "rest" };
    }

    function start() {
        const f = flux();
        for (const type of STATE_EVENTS) f.subscribe(type, () => pushState());
        f.subscribe("SPEAKING", (e) => {
            if (e.context && e.context !== "default") return;
            if (e.speakingFlags) speaking.add(e.userId); else speaking.delete(e.userId);
            pushState();
        });
        // A missed "stopped talking" event would otherwise stick until the
        // next change (someone muting). Re-check once a second during a call;
        // an unchanged state isn't sent again.
        setInterval(() => {
            if (!voiceChannelId()) { speaking.clear(); return; }
            pushState();
        }, 1000);
        f.subscribe("MESSAGE_CREATE", onMessage);
        watchCaptcha();
        for (const t of ["CALL_CREATE", "CALL_UPDATE", "CALL_DELETE"]) f.subscribe(t, (e) => onCall({ ...e, type: t }));
        // Joining the call any other way (in Discord itself) also ends the ringing.
        f.subscribe("VOICE_CHANNEL_SELECT", () => {
            if (incoming && voiceChannelId() === incoming.channel_id) onCall({ type: "CALL_DELETE", channelId: incoming.channel_id });
        });
        // Backup: Discord's call list, checked every second (catches rings the
        // events above miss, and notices when ringing stops).
        setInterval(() => {
            try {
                if (incoming && Date.now() - incoming.since > 65000) onCall({ type: "CALL_DELETE", channelId: incoming.channel_id });
                const CS = store("CallStore");
                const u = me();
                if (!CS || !u) return;
                const calls = CS.getCalls ? CS.getCalls() : [];
                const ringingIds = new Set();
                for (const c of calls || []) {
                    const cid = c.channelId || c.channel_id;
                    const ringing = (c.ringing || []).map(String);
                    if (ringing.includes(String(u.id))) {
                        ringingIds.add(cid);
                        if (incoming && incoming.channel_id === cid) incoming.seenInStore = true;
                    }
                    if (ringing.includes(String(u.id)) && (!incoming || incoming.channel_id !== cid)) onCall({ type: "POLL", channelId: cid, ringing });
                }
                // Drop the ring once Discord says it stopped (only when its call
                // list can actually be read), or after Discord's ring time.
                if (incoming && !ringingIds.has(incoming.channel_id)) {
                    const age = Date.now() - incoming.since;
                    let stopped = age > 65000;
                    // Trust Discord's call list only if it has shown us ringing.
                    if (!stopped && incoming.seenInStore && CS.getCall && age > 4000) {
                        const c = CS.getCall(incoming.channel_id);
                        stopped = !c || (Array.isArray(c.ringing) && !c.ringing.map(String).includes(String(u.id)));
                    }
                    if (stopped) onCall({ type: "CALL_DELETE", channelId: incoming.channel_id });
                }
            } catch (_) { }
        }, 1000);
        // A call that was already ringing when Discordio loaded.
        try {
            const CS = store("CallStore");
            const u = me();
            const calls = CS && (CS.getCalls ? CS.getCalls() : Object.values(CS.getState ? CS.getState().calls || {} : {}));
            for (const c of calls || []) onCall({ type: "CALL_UPDATE", channelId: c.channelId || c.channel_id, ringing: c.ringing || [] });
            void u;
        } catch (_) { }
        setInterval(() => pushState(), 2000);
        ready = true;
        log("bridge ready", VERSION);
        hello();
    }

    // Wait for Vencord to finish wiring up Discord's modules.
    (function waitForDiscord(tries = 0) {
        try {
            if (window.Vencord && Vencord.Webpack && Vencord.Webpack.Common && Vencord.Webpack.Common.FluxDispatcher && Vencord.Webpack.Common.UserStore) {
                return start();
            }
        } catch (_) { }
        if (tries === 600) warn("Discord's modules still not ready after 60s; Vencord may have failed to load");
        setTimeout(() => waitForDiscord(tries + 1), 100);
    })();

    // On-screen keyboard: tapping a text field asks Steam to show its keyboard.
    setInterval(() => {
        try {
            for (const el of document.querySelectorAll('input, textarea, [role="textbox"], [contenteditable="true"]')) {
                if (el.dataset.discordioKb) continue;
                el.dataset.discordioKb = "1";
                el.addEventListener("click", () => emit("keyboard", null));
            }
        } catch (_) { }
    }, 1000);

    connect();
})();
