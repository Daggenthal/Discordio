// Discordio media helpers (Discord page side):
//   1. Discord's sounds and voice playback (autoplay unlock)
//   2. keeping relayed audio/video flowing (Chromium relay bug)
//   3. watching Discord's own voice/stream connection, for diagnostics
//   4. microphone and speaker tests
//
// 1. Discord's sounds (ringing, joins, notifications) in the Steam view.
//
// Chromium only lets a page play sound after the user has interacted with
// it. Discord runs in a view you rarely click into, so its sounds (like the
// ringing while you call someone) were silently blocked. The backend grants
// the page that "has interacted" status when it connects (DevTools
// userGesture), and this script:
//   - records every blocked or failed play() for diagnostics,
//   - retries ringing/looping sounds that were blocked, once unlocked,
//   - resumes Web Audio contexts that started suspended,
//   - offers a test sound.
(() => {
    if (window.top !== window) return;
    const D = window.DISCORDIO;
    if (!D || D.media) return;

    const stats = { played: 0, blocked: 0, failed: 0, unlocks: 0, last: null };
    const blocked = new Map(); // element -> time it was blocked
    const contexts = new Set();

    const describe = (el) => {
        const src = el.currentSrc || el.src || (el.srcObject ? "live stream" : "");
        return (src.split("/").pop() || "sound").split("?")[0].slice(0, 60);
    };

    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
        const el = this;
        const p = origPlay.apply(el, args);
        if (p && typeof p.then === "function") {
            p.then(
                () => { stats.played++; blocked.delete(el); },
                (e) => {
                    if (e && e.name === "NotAllowedError") {
                        stats.blocked++;
                        stats.last = `blocked by Chromium's autoplay rule: ${describe(el)}`;
                        blocked.set(el, Date.now());
                        D.emit("sound_blocked", { sound: describe(el) });
                    } else if (e && e.name !== "AbortError") {
                        stats.failed++;
                        stats.last = `${e.name}: ${e.message} (${describe(el)})`;
                    }
                }
            );
        }
        return p;
    };

    for (const name of ["AudioContext", "webkitAudioContext"]) {
        const AC = window[name];
        if (!AC) continue;
        window[name] = new Proxy(AC, {
            construct(target, args, newTarget) {
                const ctx = Reflect.construct(target, args, newTarget);
                contexts.add(new WeakRef(ctx));
                return ctx;
            },
        });
    }

    // Called by the backend through DevTools with userGesture, which counts
    // as the user having interacted with the page.
    window.DISCORDIO_UNLOCK_AUDIO = () => {
        stats.unlocks++;
        let resumed = 0, retried = 0;
        for (const ref of [...contexts]) {
            const ctx = ref.deref();
            if (!ctx || ctx.state === "closed") { contexts.delete(ref); continue; }
            if (ctx.state === "suspended") { ctx.resume().catch(() => { }); resumed++; }
        }
        const now = Date.now();
        for (const [el, at] of [...blocked]) {
            blocked.delete(el);
            // Replay looping sounds (ringing) and anything blocked moments ago;
            // an old one-shot notification sound would just be confusing now.
            if (el.paused && (el.loop || now - at < 3000)) {
                origPlay.call(el).then(() => stats.played++, () => { });
                retried++;
            }
        }
        return {
            activated: !!(navigator.userActivation && navigator.userActivation.hasBeenActive),
            resumed, retried,
        };
    };

    function status() {
        return {
            ...stats,
            activated: !!(navigator.userActivation && navigator.userActivation.hasBeenActive),
            suspendedContexts: [...contexts].filter((r) => r.deref() && r.deref().state === "suspended").length,
        };
    }

    async function testSound() {
        // Discord's own sound player first: it uses the output device chosen in Discord.
        let player = null;
        try { player = Vencord.Webpack.findByProps("playSound", "createSound"); } catch (_) { }
        if (player && typeof player.createSound === "function") {
            const s = player.createSound("call_calling", "call_calling", 0.6);
            try {
                if (typeof s.play === "function") s.play();
                setTimeout(() => { try { s.stop ? s.stop() : s.pause && s.pause(); } catch (_) { } }, 2500);
                await new Promise((r) => setTimeout(r, 600));
                return { ok: true, how: "Discord's ringing sound for 2.5s", ...status() };
            } catch (e) {
                stats.last = `test sound: ${e}`;
            }
        }
        // Fallback: a short beep through Web Audio.
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === "suspended") await ctx.resume().catch(() => { });
        if (ctx.state !== "running") {
            throw new Error(`audio is blocked in the Discord view (state ${ctx.state}); ${stats.last || ""}`);
        }
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0.15;
        osc.frequency.value = 660;
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.4);
        setTimeout(() => ctx.close().catch(() => { }), 800);
        return { ok: true, how: "a short beep (Discord's sound player wasn't found)", ...status() };
    }

    D.method("soundStatus", () => status());
    D.method("testSound", () => testSound());

    // ------------------------------------------------------------------ 2.
    // Chromium only pulls audio/video out of a stream that arrived over
    // WebRTC when something is playing it. Without that, Discord's audio
    // processing (Web Audio) gets silence from our microphone bridge, and the
    // Go Live track can stay black. A hidden, muted player per stream fixes
    // both; muted playback is always allowed, so it doesn't need the unlock.
    const sinks = document.createElement("div");
    sinks.style.cssText = "position:fixed;width:1px;height:1px;left:-10px;top:-10px;overflow:hidden;opacity:0;pointer-events:none";
    const mountSinks = () => { if (!sinks.isConnected && document.body) document.body.appendChild(sinks); };
    function keepFlowing(stream, label) {
        mountSinks();
        const kind = stream.getVideoTracks().length ? "video" : "audio";
        const el = document.createElement(kind);
        el.muted = true;
        el.autoplay = true;
        el.playsInline = true;
        el.dataset.discordio = label || kind;
        el.srcObject = stream;
        sinks.appendChild(el);
        origPlay.call(el).catch((e) => D.warn(`keep-alive player for ${label} didn't start:`, e && e.name));
        const done = () => {
            if (stream.getTracks().every((t) => t.readyState === "ended")) { el.srcObject = null; el.remove(); }
        };
        for (const t of stream.getTracks()) t.addEventListener("ended", done);
        return el;
    }

    // ------------------------------------------------------------------ 3.
    const peers = new Set(); // WeakRef<RTCPeerConnection>
    const videoTracks = [];  // { track, at }
    // The newest live remote video, preferring one that's sending frames.
    function latestRemoteVideo(since) {
        const live = videoTracks.filter((v) => v.track.readyState === "live" && v.at >= (since || 0));
        const sending = live.filter((v) => !v.track.muted);
        const pick = (sending.length ? sending : live).sort((a, b) => b.at - a.at)[0];
        return pick ? pick.track : null;
    }
    const RPC = window.RTCPeerConnection;
    if (RPC) {
        // A construct proxy (not a wrapper function) so code that extends
        // RTCPeerConnection still gets instances of its own class.
        window.RTCPeerConnection = new Proxy(RPC, {
            construct(target, args, newTarget) {
                const pc = Reflect.construct(target, args, newTarget);
                peers.add(new WeakRef(pc));
                // Remote video (cameras, streams you watch): for the overlay's
                // picture-in-picture.
                pc.addEventListener("track", (e) => {
                    if (e.track && e.track.kind === "video" && !pc.__discordio) {
                        videoTracks.push({ track: e.track, at: Date.now() });
                        if (videoTracks.length > 20) videoTracks.shift();
                    }
                });
                const id = peers.size;
                let lastState = "";
                pc.addEventListener("connectionstatechange", () => {
                    if (pc.__discordio) return;
                    const st = pc.connectionState;
                    if (st === lastState) return;
                    lastState = st;
                    // Shows up in Discordio's log and reports.
                    (st === "failed" ? D.warn : D.log)(`Discord connection #${id}: ${st}`);
                    if (st === "failed" || st === "connected") D.emit("rtc", { id, state: st });
                });
                return pc;
            },
        });
    }

    async function rtcStats() {
        const out = [];
        for (const ref of [...peers]) {
            const pc = ref.deref();
            if (!pc) { peers.delete(ref); continue; }
            if (pc.connectionState === "closed") continue;
            let tracks = [];
            try { tracks = pc.getSenders().filter((x) => x.track).map((x) => `${x.track.kind}:${x.track.readyState}${x.track.muted ? ":muted" : ""}`); } catch (_) { }
            const info = {
                who: pc.__discordio || "discord", tracks,
                state: pc.connectionState, ice: pc.iceConnectionState,
                sent: {}, received: {}, path: null,
            };
            try {
                const stats = await pc.getStats();
                const byId = {};
                stats.forEach((r) => { byId[r.id] = r; });
                stats.forEach((r) => {
                    const kind = r.kind || r.mediaType;
                    if (r.type === "outbound-rtp") {
                        const k = info.sent[kind] = info.sent[kind] || { bytes: 0, packets: 0 };
                        k.bytes += r.bytesSent || 0; k.packets += r.packetsSent || 0;
                        if (kind === "video") {
                            k.frames = (k.frames || 0) + (r.framesEncoded || 0);
                            k.size = r.frameWidth ? `${r.frameWidth}x${r.frameHeight}` : k.size;
                            k.fps = r.framesPerSecond != null ? r.framesPerSecond : k.fps;
                            k.encoder = r.encoderImplementation || k.encoder;
                            k.limit = r.qualityLimitationReason || k.limit;
                            k.keyframeRequests = (k.keyframeRequests || 0) + (r.pliCount || 0) + (r.firCount || 0);
                            k.active = r.active !== false;
                            const codec = r.codecId && byId[r.codecId];
                            if (codec) k.codec = codec.mimeType;
                        }
                    } else if (r.type === "inbound-rtp") {
                        const k = info.received[kind] = info.received[kind] || { bytes: 0, packets: 0 };
                        k.bytes += r.bytesReceived || 0; k.packets += r.packetsReceived || 0;
                        if (kind === "audio" && r.audioLevel != null) k.level = Math.max(k.level || 0, +r.audioLevel.toFixed(3));
                        if (kind === "video") { k.frames = (k.frames || 0) + (r.framesDecoded || 0); const codec = r.codecId && byId[r.codecId]; if (codec) k.codec = codec.mimeType; }
                    } else if (r.type === "media-source" && kind === "audio" && r.audioLevel != null) {
                        info.sent.micLevel = Math.max(info.sent.micLevel || 0, +r.audioLevel.toFixed(3));
                    } else if (r.type === "candidate-pair" && (r.nominated || r.selected) && r.state === "succeeded") {
                        const l = byId[r.localCandidateId] || {}, rem = byId[r.remoteCandidateId] || {};
                        info.path = `${l.candidateType || "?"}/${l.protocol || "?"} -> ${rem.candidateType || "?"}/${rem.protocol || "?"}`;
                    }
                });
            } catch (e) { info.error = String(e); }
            out.push(info);
        }
        return out;
    }
    D.method("rtcStats", () => rtcStats());

    // ------------------------------------------------------------------ 4.
    // Microphone test: the same microphone Discord would get (through the
    // bridge), measured in this page. Optionally plays it back so you hear
    // yourself through Discord's output, which also tests the speakers.
    let micTest = null;
    async function startMicTest({ seconds = 6, loopback = false } = {}) {
        if (micTest) micTest.stop();
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        keepFlowing(stream, "mic test");
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === "suspended") await ctx.resume().catch(() => { });
        const audioState = ctx.state;
        const src = ctx.createMediaStreamSource(stream);
        const an = ctx.createAnalyser();
        an.fftSize = 1024;
        src.connect(an);
        if (loopback) src.connect(ctx.destination);
        const buf = new Float32Array(an.fftSize);
        let peak = 0, sum = 0, n = 0;
        const timer = setInterval(() => {
            an.getFloatTimeDomainData(buf);
            let sq = 0;
            for (const v of buf) sq += v * v;
            const level = Math.min(1, Math.sqrt(sq / buf.length) * 4);
            peak = Math.max(peak, level); sum += level; n++;
            D.emit("mic_level", { level: +level.toFixed(3) });
        }, 100);
        const stop = () => {
            clearInterval(timer);
            try { stream.getTracks().forEach((t) => t.stop()); } catch (_) { }
            ctx.close().catch(() => { });
            micTest = null;
        };
        micTest = { stop };
        await new Promise((r) => setTimeout(r, seconds * 1000));
        if (micTest && micTest.stop === stop) stop();
        return {
            peak: +peak.toFixed(3), average: n ? +(sum / n).toFixed(3) : 0,
            audioState, loopback,
            verdict: peak < 0.02 ? "silent" : peak < 0.08 ? "quiet" : "ok",
        };
    }
    D.method("micTest", (p) => startMicTest(p || {}));
    D.method("micTestStop", () => { if (micTest) micTest.stop(); return { ok: true }; });

    // ------------------------------------------------------------------ 5.
    // Keep Discordio's microphone / screen capture hooks in place. Vencord's
    // web build has a WebScreenShare plugin (on by default) that swaps
    // getDisplayMedia for its own picker window when it starts; in the
    // hidden Discord view nobody could answer that picker, so Go Live waited
    // forever with no video. Assignments are ignored (and logged) instead.
    function pin(name, fn) {
        const md = navigator.mediaDevices;
        if (!md) return;
        const replaced = new Set();
        const accessor = {
            configurable: true,
            get: () => fn,
            set: (other) => {
                const who = (other && other.name) || "another script";
                if (!replaced.has(who)) {
                    replaced.add(who);
                    D.log(`kept Discordio's ${name} (${who} tried to replace it)`);
                }
            },
        };
        try { Object.defineProperty(md, name, accessor); } catch (e) { md[name] = fn; }
        try {
            const proto = Object.getPrototypeOf(md);
            if (proto && name in proto) Object.defineProperty(proto, name, { configurable: true, writable: true, value: fn });
        } catch (_) { }
    }

    D.media = { keepFlowing, status, rtcStats, pin, latestRemoteVideo };
})();
