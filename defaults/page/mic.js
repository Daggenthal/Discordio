// Discordio microphone bridge (Discord page side).
//
// Discord's page can't open the microphone inside Steam's browser view, so
// getUserMedia is answered with audio captured by the Discordio plugin in
// Steam's own UI, sent over a local WebRTC connection. Signalling goes
// through the bridge (non-trickle: each side waits for its ICE candidates, so
// one offer and one answer are all that's exchanged).
(() => {
    const D = window.DISCORDIO;
    if (!D) return;
    const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const answers = {};
    let pc = null, stream = null, pending = null, seq = 0, lastError = null;

    const iceDone = (p) => new Promise((resolve) => {
        if (p.iceGatheringState === "complete") return resolve();
        const t = setTimeout(resolve, 2000);
        p.addEventListener("icegatheringstatechange", () => {
            if (p.iceGatheringState === "complete") { clearTimeout(t); resolve(); }
        });
    });

    const healthy = () => stream && pc && pc.connectionState === "connected" &&
        stream.getAudioTracks().some((t) => t.readyState === "live");

    function micStream() {
        if (healthy()) return Promise.resolve(stream);
        if (pending) return pending;
        pending = (async () => {
            const id = ++seq;
            if (pc) { try { pc.close(); } catch (_) { } }
            const p = new RTCPeerConnection({ iceServers: [] });
            pc = p;
            p.addTransceiver("audio", { direction: "recvonly" });
            const out = new MediaStream();
            const gotTrack = new Promise((resolve) => {
                p.ontrack = (e) => { out.addTrack(e.track); resolve(out); };
            });
            await p.setLocalDescription(await p.createOffer());
            await iceDone(p);
            const answer = new Promise((resolve, reject) => { answers[id] = { resolve, reject }; });
            D.emit("mic", { type: "offer", id, sdp: p.localDescription.sdp });
            const timeout = (ms, what) => new Promise((_, reject) => setTimeout(() => reject(new Error(what)), ms));
            const a = await Promise.race([answer, timeout(15000, "Steam didn't answer the microphone request")]);
            await p.setRemoteDescription({ type: "answer", sdp: a.sdp });
            const s = await Promise.race([gotTrack, timeout(10000, "no audio arrived from Steam")]);
            stream = s;
            lastError = null;
            D.log("microphone bridge connected");
            return s;
        })().catch((e) => {
            lastError = String(e.message || e);
            D.emit("mic", { type: "error", error: lastError });
            throw e;
        }).finally(() => { pending = null; });
        return pending;
    }

    D.onPush("mic", (d) => {
        const w = answers[d.id];
        if (!w) return;
        delete answers[d.id];
        if (d.error) w.reject(new Error(d.error)); else w.resolve(d);
    });

    navigator.mediaDevices.getUserMedia = async (constraints) => {
        if (constraints && constraints.audio && !constraints.video) {
            const s = await micStream();
            // Clones, so Discord stopping its copy doesn't end the bridge.
            return new MediaStream(s.getAudioTracks().map((t) => t.clone()));
        }
        return realGetUserMedia(constraints);
    };

    D.method("micStatus", () => ({
        connection: pc ? pc.connectionState : "none",
        tracks: stream ? stream.getAudioTracks().map((t) => t.readyState) : [],
        lastError,
    }));
    D.method("micReconnect", async () => {
        if (pc) { try { pc.close(); } catch (_) { } }
        stream = null;
        await micStream();
        return { ok: true };
    });
})();
