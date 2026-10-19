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
        return Object.values(states).map((s) => {
            const u = C().UserStore.getUser(s.userId);
            return {
                id: s.userId, name: userName(u), avatar: avatarUrl(u),
                muted: !!(s.selfMute || s.mute), deafened: !!(s.selfDeaf || s.deaf),
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
        };
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

    async function goLive(stop, quality) {
        const vc = voiceChannelId();
        if (!stop && !vc) throw new Error("Join a voice channel or call first");
        if (!stop && quality) applyStreamQuality(quality);
        const tried = [];
        if (!stop) {
            try {
                const fn = W().find((m) => typeof m === "function" && m.length >= 2 &&
                    /STREAM_START|streamType/.test(m.toString()) && /analyticsLocation|appContext/.test(m.toString()), { isIndirect: true });
                if (fn) {
                    const ch = C().ChannelStore.getChannel(vc);
                    await fn((ch && ch.guild_id) || null, vc, "Activity Panel");
                    return { method: "action" };
                }
                tried.push("action: not found");
            } catch (e) { tried.push("action: " + e); }
        }
        try {
            const pattern = stop ? /stop streaming/i : /share your screen|^stream /i;
            const b = [...document.querySelectorAll("button[aria-label], [role=button][aria-label]")]
                .find((el) => pattern.test(el.getAttribute("aria-label")));
            if (b) { b.click(); return { method: "ui" }; }
            tried.push("ui: button not found");
        } catch (e) { tried.push("ui: " + e); }
        if (stop) {
            try {
                const s = store("ApplicationStreamingStore");
                const a = s && s.getCurrentUserActiveStream && s.getCurrentUserActiveStream();
                if (!a) return { method: "none" };
                const key = [a.streamType, a.guildId, a.channelId, a.ownerId].filter(Boolean).join(":");
                dispatch({ type: "STREAM_STOP", streamKey: key, appContext: "APP" });
                return { method: "dispatch" };
            } catch (e) { tried.push("dispatch: " + e); }
        }
        throw new Error(`Couldn't ${stop ? "stop" : "start"} the stream (${tried.join("; ")})`);
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
        const put = await fetch(att.upload_url, { method: "PUT", body: new Blob([bytes], { type: "image/jpeg" }) });
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
            return { id, name: userName(u), avatar: avatarUrl(u), status: (PS && PS.getStatus(id)) || "offline" };
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
    m("setActivity", ({ game }) => setActivity(game));
    m("recentChannels", () => recentTextChannels());
    m("postScreenshot", async ({ channelId, userId, data, filename }) =>
        postScreenshot(channelId || await dmChannel(userId), data, filename));
    m("textChannels", ({ guildId }) => textChannels(guildId));
    m("goLive", ({ quality }) => goLive(false, quality));
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

    function onMessage(e) {
        try {
            const msg = e.message;
            const u = me();
            if (!msg || !u || !msg.author || msg.author.id === u.id) return;
            const ch = C().ChannelStore.getChannel(msg.channel_id);
            const isDM = ch && !ch.guild_id;
            const mentioned = (msg.mentions || []).some((x) => (x.id || x) === u.id);
            if (!isDM && !mentioned) return;
            const g = ch && ch.guild_id ? C().GuildStore.getGuild(ch.guild_id) : null;
            emit("notification", {
                title: g ? `${userName(msg.author)} in #${ch.name}` : userName(msg.author),
                body: (msg.content || (msg.attachments && msg.attachments.length ? "[attachment]" : "")).slice(0, 140),
            });
        } catch (_) { }
    }

    function start() {
        const f = flux();
        for (const type of STATE_EVENTS) f.subscribe(type, () => pushState());
        f.subscribe("SPEAKING", (e) => {
            if (e.speakingFlags) speaking.add(e.userId); else speaking.delete(e.userId);
            pushState();
        });
        f.subscribe("MESSAGE_CREATE", onMessage);
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
