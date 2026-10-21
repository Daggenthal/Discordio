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

    const speaking = new Set();

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
                live: !!s.selfStream, video: !!s.selfVideo, speaking: speaking.has(s.userId),
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
            user: u ? { id: u.id, name: userName(u), avatar: u.avatar || null, avatarUrl: avatarUrl(u), premiumType: u.premiumType ?? 0 } : null,
            media: media(),
            voice: voiceInfo(),
            status: myStatus(),
        };
    }

    // ------------------------------------------------------------- status
    const STATUSES = ["online", "idle", "dnd", "invisible"];
    function myStatus() {
        const u = me();
        if (!u) return null;
        let status = "online", custom = null;
        try {
            const set = discordSetting("status", "status");
            const v = set && set.getSetting && set.getSetting();
            status = (STATUSES.includes(v) ? v : null) || store("PresenceStore").getStatus(u.id) || "online";
        } catch (_) { }
        try {
            const set = discordSetting("status", "customStatus");
            const v = set && set.getSetting && set.getSetting();
            if (v && v.text) custom = v.text;
        } catch (_) { }
        if (custom === null) {
            try {
                const acts = store("PresenceStore").getActivities(u.id) || [];
                const c = acts.find((a) => a.type === 4);
                if (c && c.state) custom = c.state;
            } catch (_) { }
        }
        return { status, custom };
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

    async function setStatus(status, custom) {
        const out = {};
        if (status !== undefined && status !== null) {
            if (!STATUSES.includes(status)) throw new Error("Unknown status " + status);
            const set = discordSetting("status", "status");
            if (set && set.updateSetting) { await set.updateSetting(status); out.status = "setting"; }
            else { await C().RestAPI.patch({ url: "/users/@me/settings", body: { status } }); out.status = "rest"; }
        }
        if (custom !== undefined && custom !== null) {
            const text = String(custom).trim().slice(0, 128);
            const set = discordSetting("status", "customStatus");
            if (set && set.updateSetting) {
                await set.updateSetting(text ? { text, expiresAtMs: "0" } : undefined);
                out.custom = "setting";
            } else {
                await C().RestAPI.patch({ url: "/users/@me/settings", body: { custom_status: text ? { text } : null } });
                out.custom = "rest";
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
    async function watchStream(userId) {
        const S = store("ApplicationStreamingStore");
        let stream = null;
        try {
            const all = (S && (S.getAllApplicationStreams ? S.getAllApplicationStreams() : [])) || [];
            stream = all.find((x) => x.ownerId === userId) || null;
        } catch (_) { }
        if (!stream) throw new Error("They aren't streaming right now");
        const key = [stream.streamType, stream.guildId, stream.channelId, stream.ownerId].filter(Boolean).join(":");
        // Watching a server stream means being in its voice channel.
        if (stream.channelId && voiceChannelId() !== stream.channelId) {
            selectVoice(stream.guildId || null, stream.channelId);
            await waitFor(() => voiceChannelId() === stream.channelId, 5000);
        }
        const a = props("watchStreamAndTransitionToStream") || props("watchStream");
        if (a && a.watchStreamAndTransitionToStream) a.watchStreamAndTransitionToStream(stream);
        else if (a && a.watchStream) a.watchStream(stream);
        else dispatch({ type: "STREAM_WATCH", streamKey: key, allowMultiple: true });
        // Show the stream full-size in Discord's call page.
        try { openCallPage(stream.channelId); } catch (_) { }
        return { ok: true };
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
        return list.map((c) => ({ id: c.id, name: c.name }));
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
                emit("call_incoming", incoming);
            } else if (!ringingMe && incoming && incoming.channel_id === cid) {
                const answered = voiceChannelId() === cid;
                incoming = null;
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
    m("react", ({ channelId, messageId, emoji, remove }) => react(channelId, messageId, emoji, !!remove));
    m("watchStream", ({ userId }) => watchStream(userId));
    m("getStatus", () => myStatus());
    m("setStatus", ({ status, custom }) => setStatus(status, custom));
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
    m("answerCall", ({ channelId }) => answerCall(channelId));
    m("declineCall", ({ channelId }) => declineCall(channelId));
    m("guilds", () => guilds());
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
    m("sendMessage", ({ channelId, userId, content }) =>
        (channelId ? Promise.resolve(channelId) : dmChannel(userId)).then((id) => sendMessage(id, content)));
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
        return {
            id: msg.id, channel_id: msg.channel_id,
            author: { id: a.id, name: friendName(u) || userName(u), avatar: avatarUrl(u) },
            text, media, reactions,
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
            emit("message", { ...m, text, channel_label: channelLabel(ch), is_dm: !!isDM });
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

    // Add / remove a reaction: Discord's action, or the same request it sends.
    async function react(channelId, messageId, emoji, remove) {
        const a = props("addReaction", "removeReaction");
        const e = { id: null, name: emoji, animated: false };
        try {
            if (a && (remove ? a.removeReaction : a.addReaction)) {
                await (remove ? a.removeReaction(channelId, messageId, e) : a.addReaction(channelId, messageId, e));
                return { ok: true, method: "action" };
            }
        } catch (err) { warn("reaction action", err); }
        const url = `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`;
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

    async function sendMessage(channelId, content) {
        content = String(content || "").trim();
        if (!content) throw new Error("Nothing to send");
        if (content.length > 2000) throw new Error("Discord messages can be at most 2000 characters");
        const actions = props("sendMessage", "editMessage");
        if (actions && actions.sendMessage) {
            try {
                // Newer Discord reads a 4th "options" argument (nonce etc.);
                // leaving it out was the "reading 'nonce'" error.
                await actions.sendMessage(channelId,
                    { content, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] },
                    undefined, { nonce: nonce() });
                return { ok: true, method: "action" };
            } catch (e) {
                warn("sendMessage action failed, using the REST API:", e);
            }
        }
        await C().RestAPI.post({ url: `/channels/${channelId}/messages`, body: { content, nonce: nonce(), tts: false } });
        return { ok: true, method: "rest" };
    }

    function start() {
        const f = flux();
        for (const type of STATE_EVENTS) f.subscribe(type, () => pushState());
        f.subscribe("SPEAKING", (e) => {
            if (e.speakingFlags) speaking.add(e.userId); else speaking.delete(e.userId);
            pushState();
        });
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
