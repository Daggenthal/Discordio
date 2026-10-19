// Discordio screen capture (Discord page side).
//
// Steam's browser view has no screen picker, so getDisplayMedia is answered
// with the game video and audio from Discordio's capture helper, received
// over a local WebRTC connection. Failures are reported to the plugin so Go
// Live can show why instead of silently doing nothing.
(() => {
    const D = window.DISCORDIO;
    if (!D) return;
    const CFG = window.DISCORDIO_CONFIG || {};
    let active = null, pending = null, lastError = null;

    function report(type, data) {
        try { D.emit("capture", { type, ...data }); } catch (_) { }
    }

    function getCapture(constraints) {
        if (active) return Promise.resolve(active.stream);
        if (pending) return pending;
        pending = new Promise((resolve, reject) => {
            const pc = new RTCPeerConnection({ iceServers: [] });
            const ws = new WebSocket(CFG.captureUrl || "ws://127.0.0.1:65124/webrtc");
            const stream = new MediaStream();
            let settled = false;

            const fail = (reason) => {
                if (settled) return;
                settled = true;
                lastError = String(reason);
                D.warn("screen capture failed:", lastError);
                report("error", { error: lastError });
                try { ws.close(); } catch (_) { }
                try { pc.close(); } catch (_) { }
                reject(new DOMException(lastError, "NotReadableError"));
            };
            const timer = setTimeout(() => fail("the capture helper didn't start a stream within 20s"), 20000);

            ws.onerror = () => fail("couldn't reach the capture helper");
            ws.onclose = () => {
                if (!settled) fail("the capture helper closed the connection");
                else if (active && active.ws === ws) { active = null; report("ended", {}); }
            };
            ws.onopen = async () => {
                try {
                    pc.addTransceiver("video", { direction: "recvonly" });
                    pc.addTransceiver("audio", { direction: "recvonly" });
                    const offer = await pc.createOffer();
                    await pc.setLocalDescription(offer);
                    ws.send(JSON.stringify({ offer: { type: offer.type, sdp: offer.sdp }, constraints: constraints || null }));
                } catch (e) { fail(e); }
            };
            pc.onicecandidate = (e) => {
                if (e.candidate && ws.readyState === 1) ws.send(JSON.stringify({ ice: e.candidate }));
            };
            ws.onmessage = async (ev) => {
                try {
                    const d = JSON.parse(ev.data);
                    if (d.sdp) await pc.setRemoteDescription(new RTCSessionDescription(d.sdp));
                    else if (d.ice) await pc.addIceCandidate(d.ice);
                    else if (d.error) fail(d.error);
                    else if (d.status) report("status", d.status);
                } catch (e) { D.warn("capture signalling", e); }
            };
            pc.onconnectionstatechange = () => {
                if (pc.connectionState === "failed") fail("the local video connection failed");
            };
            pc.ontrack = (e) => {
                const track = e.track;
                const stop = track.stop.bind(track);
                track.stop = () => {
                    try { ws.send(JSON.stringify({ stop: true })); } catch (_) { }
                    try { pc.close(); } catch (_) { }
                    if (active && active.ws === ws) active = null;
                    report("ended", {});
                    stop();
                };
                stream.addTrack(track);
                if (!settled && stream.getVideoTracks().length) {
                    settled = true;
                    clearTimeout(timer);
                    active = { stream, ws, pc };
                    lastError = null;
                    report("started", {});
                    resolve(stream);
                }
            };
        }).finally(() => { pending = null; });
        return pending;
    }

    navigator.mediaDevices.getDisplayMedia = (constraints) => getCapture(constraints);

    D.method("captureStatus", () => ({
        active: !!active,
        connection: active ? active.pc.connectionState : "none",
        tracks: active ? active.stream.getTracks().map((t) => `${t.kind}:${t.readyState}`) : [],
        lastError,
    }));
})();
