window.Vencord.Plugins.plugins.Deckcord = {
    name: "Deckcord",
    description: "Plugin required for Deckcord to work",
    authors: [],
    required: true,
    startAt: "DOMContentLoaded",
    async start() {
        window.old_enumerate_devices = navigator.mediaDevices.enumerateDevices
        navigator.mediaDevices.enumerateDevices = async () => {
            const devices = await window.old_enumerate_devices();
            return devices.filter(f => f.label != "Filter Chain Source" && f.label != "Virtual Source" && !(f.label == "" && f.deviceId == "default"))
        }

        navigator.mediaDevices.getUserMedia = (_) => new Promise(async (resolve, reject) => {
            if (window.MIC_STREAM != undefined && window.MIC_PEER_CONNECTION != undefined && window.MIC_PEER_CONNECTION.connectionState == "connected") {
                console.log("WebRTC stream available. Returning that.");
                return resolve(window.MIC_STREAM);
            }

            console.log("Starting WebRTC handshake for mic stream");
            const peerConnection = new RTCPeerConnection(null);
            window.MIC_PEER_CONNECTION = peerConnection;

            window.DECKCORD_WS.addEventListener("message", async (e) => {
                const data = JSON.parse(e.data);
                if (data.type != "$webrtc") return;

                const remoteDescription = new RTCSessionDescription(data.payload);
                await peerConnection.setRemoteDescription(remoteDescription);
            });

            peerConnection.addEventListener("icecandidate", event => {
                if (event.candidate) {
                    window.DECKCORD_WS.send(JSON.stringify({ type: "$MIC_WEBRTC", ice: event.candidate }));
                }
            });

            peerConnection.onaddstream = (ev) => {
                const stream = ev.stream;
                console.log("WEBRTC STREAM", stream);
                window.MIC_STREAM = stream;
                for (const track of stream.getTracks()) {
                    track.stop = () => { console.log("CALLED STOP ON TRACK") }
                    track
                }
                resolve(stream);
            }

            peerConnection.ontrack = (ev) => {
                ev.track.stop = () => { console.log("CALLED STOP ON TRACK") }
            }

            const offer = await peerConnection.createOffer({ offerToReceiveVideo: false, offerToReceiveAudio: true });
            await peerConnection.setLocalDescription(offer);
            window.DECKCORD_WS.send(JSON.stringify({ type: "$MIC_WEBRTC", offer: offer }));
        });

        function dataURLtoFile(dataurl, filename) {
            var arr = dataurl.split(','),
                mime = arr[0].match(/:(.*?);/)[1],
                bstr = atob(arr[arr.length - 1]),
                n = bstr.length,
                u8arr = new Uint8Array(n);
            while (n--) {
                u8arr[n] = bstr.charCodeAt(n);
            }
            return new File([u8arr], filename, { type: mime });
        }

        function patchTypingField() {
            const t = setInterval(() => {
                try {
                    document.querySelectorAll("[role=\"textbox\"]")[0].onclick = (e) => fetch("http://127.0.0.1:65123/openkb", { mode: "no-cors" });
                    clearInterval(t);
                } catch (err) { }
            }, 100)
        }

        async function getAppId(name) {
            const res = await Vencord.Webpack.Common.RestAPI.get({ url: "/applications/detectable" });
            if (res.ok) {
                const item = res.body.filter(e => e.name == name);
                if (item.length > 0) return item[0].id;
            }
            return "0";
        }

        let CloudUpload;
        CloudUpload = Vencord.Webpack.findLazy(m => m.prototype?.trackUploadFinished);;
        function sendAttachmentToChannel(channelId, attachment_b64, filename) {
            return new Promise((resolve, reject) => {
                const file = dataURLtoFile(`data:text/plain;base64,${attachment_b64}`, filename);
                const upload = new CloudUpload({
                    file: file,
                    isClip: false,
                    isThumbnail: false,
                    platform: 1,
                }, channelId, false, 0);
                upload.on("complete", () => {
                    Vencord.Webpack.Common.RestAPI.post({
                        url: `/channels/${channelId}/messages`,
                        body: {
                            channel_id: channelId,
                            content: "",
                            nonce: Vencord.Webpack.Common.SnowflakeUtils.fromTimestamp(Date.now()),
                            sticker_ids: [],
                            type: 0,
                            attachments: [{
                                id: "0",
                                filename: upload.filename,
                                uploaded_filename: upload.uploadedFilename
                            }]
                        }
                    });
                    resolve(true);
                });
                upload.on("error", () => resolve(false))
                upload.upload();
            })
        }

        // Start or stop Go Live. The original called a hardcoded webpack module
        // id (799808), which changes with nearly every Discord release. This tries
        // a few independent methods and reports which one worked, or why none did.
        async function deckcordGoLive(stop) {
            const W = Vencord.Webpack;
            const vcId = W.findStore("SelectedChannelStore").getVoiceChannelId();
            if (!stop && !vcId) return { error: "Not in a voice channel" };
            const errors = [];

            // 1. Discord's own stream action creator, located by behaviour rather
            //    than by module id.
            try {
                const fn = W.find(m => typeof m === "function" && m.length >= 2 && /STREAM_START|streamType/.test(m.toString()) && /analyticsLocation|appContext/.test(m.toString()), { isIndirect: true });
                if (fn && !stop) {
                    const guildId = W.Common.ChannelStore.getChannel(vcId)?.guild_id ?? null;
                    await fn(guildId, vcId, "Activity Panel");
                    return { method: "action" };
                }
            } catch (e) { errors.push("action: " + e); }

            // 2. Press the button in Discord's own UI. English labels only, but it
            //    keeps working when internals move around.
            try {
                const pattern = stop ? /stop streaming/i : /share your screen|^stream /i;
                const button = [...document.querySelectorAll("button[aria-label], [role=button][aria-label]")]
                    .find(b => pattern.test(b.getAttribute("aria-label")));
                if (button) {
                    button.click();
                    return { method: "ui", note: "Clicked Discord's button; check Discord for a confirmation prompt" };
                }
                errors.push("ui: button not found");
            } catch (e) { errors.push("ui: " + e); }

            // 3. Stopping only: dispatch the stop event directly.
            if (stop) {
                try {
                    const S = W.findStore("ApplicationStreamingStore");
                    const active = S?.getCurrentUserActiveStream?.();
                    if (!active) return { method: "none", note: "No active stream" };
                    const key = [active.streamType, active.guildId, active.channelId, active.ownerId].filter(Boolean).join(":");
                    FluxDispatcher.dispatch({ type: "STREAM_STOP", streamKey: key, appContext: "APP" });
                    return { method: "dispatch" };
                } catch (e) { errors.push("dispatch stop: " + e); }
            }

            return { error: "Could not " + (stop ? "stop" : "start") + " the stream (" + errors.join("; ") + ")" };
        }

        // ---- Lists and actions for the QAM (servers, voice, friends) ----------
        const store = (name) => { try { return Vencord.Webpack.findStore(name); } catch (_) { return null; } };
        const userName = (u) => u ? (u.globalName || u.global_name || u.username) : "Unknown";
        const avatarUrl = (u) => u && u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.webp?size=64` : null;

        function voiceMembers(channelId) {
            const VS = store("VoiceStateStore");
            const states = VS ? Object.values(VS.getVoiceStatesForChannel(channelId) || {}) : [];
            return states.map(s => {
                const u = Vencord.Webpack.Common.UserStore.getUser(s.userId);
                return {
                    id: s.userId, name: userName(u), avatar: avatarUrl(u),
                    muted: !!(s.selfMute || s.mute), deafened: !!(s.selfDeaf || s.deaf),
                    live: !!s.selfStream, video: !!s.selfVideo,
                };
            });
        }

        function discordioQuery(what, arg) {
            const C = Vencord.Webpack.Common;
            if (what === "guilds") {
                // Several routes, because Discord renames these internals often.
                const GS = C.GuildStore || store("GuildStore");
                if (!GS) return { error: "Discord's guild store was not found" };
                const tried = [];
                let ids = [];
                const sorted = store("SortedGuildStore");
                try { ids = sorted.getFlattenedGuildIds() || []; } catch (e) { tried.push("flattened: " + e); }
                if (!ids.length) {
                    try { ids = (sorted.getGuildFolders() || []).flatMap(f => f.guildIds || []); } catch (e) { tried.push("folders: " + e); }
                }
                if (!ids.length) {
                    try { ids = GS.getGuildIds ? GS.getGuildIds() : []; } catch (e) { tried.push("ids: " + e); }
                }
                if (!ids.length) {
                    try {
                        const all = GS.getGuilds();
                        ids = all instanceof Map ? [...all.keys()] : Object.keys(all || {});
                    } catch (e) { tried.push("all: " + e); }
                }
                const guilds = ids.map(id => { try { return GS.getGuild(id); } catch (_) { return null; } }).filter(Boolean).map(g => ({
                    id: g.id, name: g.name,
                    icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.webp?size=64` : null,
                }));
                if (!guilds.length && tried.length) return { error: "Could not list servers (" + tried.join("; ") + ")" };
                return guilds;
            }
            if (what === "voice_channels") {
                let channels = [];
                try {
                    const GCS = store("GuildChannelStore");
                    const vocal = GCS && GCS.getChannels(arg) && GCS.getChannels(arg).VOCAL;
                    if (vocal) channels = vocal.map(v => v.channel || v).filter(Boolean);
                } catch (_) { }
                if (!channels.length) {
                    // Fallback: every voice (2) and stage (13) channel in the server.
                    try {
                        const all = C.ChannelStore.getMutableGuildChannelsForGuild(arg) || {};
                        channels = Object.values(all).filter(ch => ch.type === 2 || ch.type === 13)
                            .sort((a, b) => (a.position || 0) - (b.position || 0));
                    } catch (e) { return { error: "Could not list voice channels: " + e }; }
                }
                return channels.map(ch => ({ id: ch.id, name: ch.name, members: voiceMembers(ch.id) }));
            }
            if (what === "voice") {
                const id = store("SelectedChannelStore").getVoiceChannelId();
                if (!id) return null;
                const ch = C.ChannelStore.getChannel(id);
                const guild = ch && ch.guild_id ? C.GuildStore.getGuild(ch.guild_id) : null;
                const dmName = ch && !ch.guild_id ? (ch.name || (ch.recipients || []).map(r => userName(C.UserStore.getUser(r))).join(", ")) : null;
                return { channel_id: id, channel_name: dmName || (ch && ch.name) || "Voice", guild_name: guild ? guild.name : "Direct call", members: voiceMembers(id) };
            }
            if (what === "friends") {
                const RS = store("RelationshipStore"), PS = store("PresenceStore");
                let ids = [];
                try { ids = RS.getFriendIDs(); } catch (_) {
                    const rel = RS.getRelationships ? RS.getRelationships() : {};
                    ids = Object.keys(rel).filter(k => rel[k] === 1 || (rel[k] && rel[k].type === 1));
                }
                const rank = { online: 0, idle: 1, dnd: 2, offline: 3 };
                return ids.map(id => {
                    const u = C.UserStore.getUser(id);
                    const status = (PS && PS.getStatus(id)) || "offline";
                    return { id, name: userName(u), avatar: avatarUrl(u), status };
                }).sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || a.name.localeCompare(b.name));
            }
            return { error: "unknown query " + what };
        }

        function selectVoice(guildId, channelId) {
            // Discord's own action creator if we can find it, otherwise the raw event.
            try {
                const actions = Vencord.Webpack.findByProps("selectVoiceChannel");
                if (actions && actions.selectVoiceChannel) { actions.selectVoiceChannel(channelId); return "action"; }
            } catch (_) { }
            FluxDispatcher.dispatch({
                type: "VOICE_CHANNEL_SELECT", guildId, channelId,
                currentVoiceChannelId: store("SelectedChannelStore").getVoiceChannelId(),
                video: false, stream: false,
            });
            return "dispatch";
        }

        async function discordioJoinVoice(channelId) {
            const ch = Vencord.Webpack.Common.ChannelStore.getChannel(channelId);
            if (!ch) return { error: "Channel not found" };
            return { ok: true, method: selectVoice(ch.guild_id || null, channelId) };
        }

        async function discordioCallFriend(userId) {
            const C = Vencord.Webpack.Common;
            let dmId = C.ChannelStore.getDMFromUserId ? C.ChannelStore.getDMFromUserId(userId) : null;
            if (!dmId) {
                const res = await C.RestAPI.post({ url: "/users/@me/channels", body: { recipients: [userId] } });
                dmId = res && res.body && res.body.id;
                if (!dmId) return { error: "Could not open a DM with that friend" };
                for (let i = 0; i < 20 && !C.ChannelStore.getChannel(dmId); i++) await new Promise(r => setTimeout(r, 100));
            }
            const method = selectVoice(null, dmId);
            try { await C.RestAPI.post({ url: `/channels/${dmId}/call/ring`, body: { recipients: null } }); } catch (_) { }
            return { ok: true, method };
        }

        // ---- In-game overlay state ----------------------------------------
        // Pushed to the backend whenever voice state or speaking changes; the
        // overlay process polls it from there.
        const discordioSpeaking = new Set();
        const OVERLAY_EVENTS = new Set([
            "VOICE_STATE_UPDATES", "VOICE_CHANNEL_SELECT", "AUDIO_TOGGLE_SELF_MUTE",
            "AUDIO_TOGGLE_SELF_DEAF", "STREAM_START", "STREAM_STOP", "STREAM_CREATE",
            "STREAM_DELETE", "RTC_CONNECTION_STATE",
        ]);
        let overlayTimer = null, lastOverlay = "";
        function pushOverlay() {
            if (overlayTimer) return;
            overlayTimer = setTimeout(() => {
                overlayTimer = null;
                try {
                    let voice = discordioQuery("voice");
                    if (voice) {
                        for (const m of voice.members) m.speaking = discordioSpeaking.has(m.id);
                    } else {
                        discordioSpeaking.clear();
                    }
                    const me = Vencord.Webpack.Common.UserStore.getCurrentUser();
                    const mine = voice && me ? voice.members.find(m => m.id === me.id) : null;
                    const state = { voice, me: mine ? { muted: mine.muted, deafened: mine.deafened, live: mine.live } : null };
                    const json = JSON.stringify(state);
                    if (json === lastOverlay) return;
                    lastOverlay = json;
                    if (window.DECKCORD_WS && window.DECKCORD_WS.readyState === 1)
                        window.DECKCORD_WS.send(JSON.stringify({ type: "$overlay", state }));
                } catch (err) { console.warn("Discordio: overlay state failed", err); }
            }, 40);
        }
        setInterval(pushOverlay, 2000);

        // ---- Stream limits (Nitro / server boosts) ----------------------------
        // Free accounts stream at up to 720p 30 fps. Nitro (and Nitro Classic)
        // unlock source resolution at 60 fps. Nitro Basic doesn't include HD
        // streaming. Boosted servers raise the cap for everyone in them:
        // level 1 = 720p 60 fps, level 2+ = 1080p 60 fps.
        function discordioStreamLimits() {
            const C = Vencord.Webpack.Common;
            const me = C.UserStore.getCurrentUser() || {};
            const pt = me.premiumType ?? me.premium_type ?? 0;
            const plan = { 0: "No Nitro", 1: "Nitro Classic", 2: "Nitro", 3: "Nitro Basic" }[pt] || "No Nitro";
            let maxHeight = 720, maxFps = 30, reason = plan;
            if (pt === 1 || pt === 2) { maxHeight = null; maxFps = 60; }
            let boost = 0, guildName = null;
            try {
                const vc = store("SelectedChannelStore").getVoiceChannelId();
                const ch = vc && C.ChannelStore.getChannel(vc);
                const g = ch && ch.guild_id && C.GuildStore.getGuild(ch.guild_id);
                if (g) { boost = g.premiumTier || 0; guildName = g.name; }
            } catch (_) { }
            if (maxHeight !== null) {
                const boostCap = boost >= 2 ? [1080, 60] : boost === 1 ? [720, 60] : null;
                if (boostCap && (boostCap[0] > maxHeight || boostCap[1] > maxFps)) {
                    maxHeight = Math.max(maxHeight, boostCap[0]);
                    maxFps = Math.max(maxFps, boostCap[1]);
                    reason = `${guildName} server boost level ${boost}`;
                }
            }
            return { premium_type: pt, plan, max_height: maxHeight, max_fps: maxFps, reason, boost_level: boost };
        }

        // Ask Discord to stream at the chosen quality, clamped to what the
        // account is allowed (this never unlocks paid quality). Best effort:
        // if Discord renamed the event, its own default is used instead.
        function applyStreamQuality(q) {
            try {
                const lim = discordioStreamLimits();
                let height = q.resolution === "source" ? 0 : parseInt(q.resolution, 10) || 720;
                if (lim.max_height !== null && (height === 0 || height > lim.max_height)) height = lim.max_height;
                const fps = Math.min(parseInt(q.fps, 10) || 30, lim.max_fps);
                FluxDispatcher.dispatch({ type: "STREAM_UPDATE_SETTINGS", preset: 3, resolution: height, frameRate: fps });
            } catch (e) { console.warn("Discordio: could not set stream quality", e); }
        }

        let MediaEngineStore, FluxDispatcher;
        console.log("Deckcord: Waiting for FluxDispatcher...");
        Vencord.Webpack.waitFor(["subscribe", "dispatch", "register"], fdm => {
            FluxDispatcher = fdm;
            Vencord.Webpack.waitFor(Vencord.Webpack.filters.byStoreName("MediaEngineStore"), m => {
                MediaEngineStore = m;
                FluxDispatcher.dispatch({ type: "MEDIA_ENGINE_SET_AUDIO_ENABLED", enabled: true, unmute: true });
            });

            function connect() {
                window.DECKCORD_WS = new WebSocket('ws://127.0.0.1:65123/socket');
                window.DECKCORD_WS.addEventListener("message", async function (e) {
                    const data = JSON.parse(e.data);
                    if (data.type.startsWith("$")) {
                        let result;
                        try {
                            switch (data.type) {
                                case "$getuser":
                                    result = Vencord.Webpack.Common.UserStore.getUser(data.id);
                                    break;
                                case "$getchannel":
                                    result = Vencord.Webpack.Common.ChannelStore.getChannel(data.id);
                                    break;
                                case "$getguild":
                                    result = Vencord.Webpack.Common.GuildStore.getGuild(data.id);
                                    break;
                                case "$getmedia":
                                    result = {
                                        mute: MediaEngineStore.isSelfMute(),
                                        deaf: MediaEngineStore.isSelfDeaf(),
                                        live: MediaEngineStore.getGoLiveSource() != undefined
                                    }
                                    break;
                                case "$get_last_channels":
                                    result = {}
                                    const ChannelStore = Vencord.Webpack.Common.ChannelStore;
                                    const GuildStore = Vencord.Webpack.Common.GuildStore;
                                    const channelIds = Object.values(JSON.parse(Vencord.Util.localStorage.SelectedChannelStore).mostRecentSelectedTextChannelIds);
                                    for (const chId of channelIds) {
                                        const ch = ChannelStore.getChannel(chId);
                                        const guild = GuildStore.getGuild(ch.guild_id);
                                        result[chId] = `${ch.name} (${guild.name})`;
                                    }
                                    break;
                                case "$get_screen_bounds":
                                    result = { width: screen.width, height: screen.height }
                                    break;
                                case "$ptt":
                                    try {
                                        MediaEngineStore.getMediaEngine().connections.values().next().value.setForceAudioInput(data.value);
                                    } catch (error) { }
                                    return;
                                case "$setptt":
                                    FluxDispatcher.dispatch({
                                        "type": "AUDIO_SET_MODE",
                                        "context": "default",
                                        "mode": data.enabled ? "PUSH_TO_TALK" : "VOICE_ACTIVITY",
                                        "options": MediaEngineStore.getSettings().modeOptions
                                    });
                                    return;
                                case "$rpc":
                                    FluxDispatcher.dispatch({
                                        type: "LOCAL_ACTIVITY_UPDATE",
                                        activity: data.game ? {
                                            application_id: await getAppId(data.game),
                                            name: data.game,
                                            type: 0,
                                            flags: 1,
                                            timestamps: { start: Date.now() }
                                        } : {},
                                        socketId: "CustomRPC",
                                    });
                                    return;
                                case "$screenshot":
                                    result = await sendAttachmentToChannel(data.channel_id, data.attachment_b64, "screenshot.jpg");
                                    break;
                                case "$golive":
                                    if (!data.stop && data.quality) applyStreamQuality(data.quality);
                                    result = await deckcordGoLive(!!data.stop);
                                    break;
                                case "$stream_limits":
                                    result = discordioStreamLimits();
                                    break;
                                case "$nav":
                                    result = window.DISCORDIO_NAV ? window.DISCORDIO_NAV(data.action) : { handled: false, error: "navigator not loaded" };
                                    break;
                                case "$query":
                                    result = discordioQuery(data.what, data.arg);
                                    break;
                                case "$disconnect_voice":
                                    result = { ok: true, method: selectVoice(null, null) };
                                    break;
                                case "$join_voice":
                                    result = await discordioJoinVoice(data.channel_id);
                                    break;
                                case "$call_friend":
                                    result = await discordioCallFriend(data.user_id);
                                    break;
                                case "$webrtc":
                                    return
                            }
                        } catch (error) {
                            // Error objects serialize to {}, so send the message text.
                            result = { error: String(error && error.message || error) }
                            if (data.increment == undefined) return;
                        }
                        const payload = {
                            type: "$deckcord_request",
                            increment: data.increment,
                            // Keep null as null ("not in a voice channel"); only undefined becomes {}.
                            result: result === undefined ? {} : result
                        };
                        console.debug(data, payload);
                        window.DECKCORD_WS.send(JSON.stringify(payload));
                        return;
                    }
                    FluxDispatcher.dispatch(data);
                });

                window.DECKCORD_WS.onopen = function (e) {
                    navigator.mediaDevices.getUserMedia();
                    Vencord.Webpack.waitFor("useState", t =>
                        window.DECKCORD_WS.send(JSON.stringify({
                            type: "LOADED",
                            result: true
                        }))
                    );
                }

                window.DECKCORD_WS.onclose = function (e) {
                    FluxDispatcher._interceptors.pop()
                    setTimeout(function () {
                        connect();
                    }, 100);
                };

                window.DECKCORD_WS.onerror = function (err) {
                    console.error('Socket encountered error: ', err.message, 'Closing socket');
                    window.DECKCORD_WS.close();
                };

                Vencord.Webpack.onceReady.then(t =>
                    window.DECKCORD_WS.send(JSON.stringify({
                        type: "CONNECTION_OPEN",
                        user: Vencord.Webpack.Common.UserStore.getCurrentUser()
                    }))
                );

                FluxDispatcher.addInterceptor(e => {
                    if (e.type == "CHANNEL_SELECT") patchTypingField();
                    if (e.type == "SPEAKING") {
                        if (e.speakingFlags) discordioSpeaking.add(e.userId); else discordioSpeaking.delete(e.userId);
                        pushOverlay();
                    } else if (OVERLAY_EVENTS.has(e.type)) {
                        setTimeout(pushOverlay, 50);
                    }
                    const shouldPass = [
                        "CONNECTION_OPEN",
                        "LOGOUT",
                        "CONNECTION_CLOSED",
                        "VOICE_STATE_UPDATES",
                        "VOICE_CHANNEL_SELECT",
                        "AUDIO_TOGGLE_SELF_MUTE",
                        "AUDIO_TOGGLE_SELF_DEAF",
                        "RPC_NOTIFICATION_CREATE",
                        "STREAM_START",
                        "STREAM_STOP"
                    ].includes(e.type);
                    if (shouldPass) {
                        console.log("Dispatching Deckcord event: ", e);
                        window.DECKCORD_WS.send(JSON.stringify(e));
                    }
                });
                console.log("Deckcord: Added event interceptor");
            }
            connect();
        });

        // Open Steam's on-screen keyboard when a text field is tapped. The
        // original stopped looking after the first tick, so the login page
        // (which renders later) usually never got the handler.
        setInterval(() => {
            try {
                for (const el of document.querySelectorAll('input, [role="textbox"]')) {
                    if (el.dataset.deckcordKb) continue;
                    el.dataset.deckcordKb = "1";
                    el.addEventListener("click", () => fetch("http://127.0.0.1:65123/openkb", { mode: "no-cors" }));
                }
            } catch (err) { }
        }, 1000);
    }
};