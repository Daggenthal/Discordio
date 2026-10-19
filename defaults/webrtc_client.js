// Replaces getDisplayMedia inside the Discord page. Steam's browser view has
// no screen picker, so the game capture comes from our local GStreamer helper
// (gst_webrtc.py) over a loopback WebRTC connection instead.
(() => {
    let pending = null;

    const getRTCStream = (constraints) => {
        if (window.DECKCORD_RTC_STREAM) return Promise.resolve(window.DECKCORD_RTC_STREAM);
        if (pending) return pending;

        pending = new Promise((resolve, reject) => {
            const peerConnection = new RTCPeerConnection({ iceServers: [] });
            const ws = new WebSocket("ws://127.0.0.1:65124/webrtc");
            const stream = new MediaStream();
            let settled = false;
            window.DECKCORD_PEER_CONNECTION = peerConnection;

            const fail = (reason) => {
                if (settled) return;
                settled = true;
                pending = null;
                console.error("Deckcord: screen capture failed:", reason);
                try { ws.close(); } catch (_) { }
                try { peerConnection.close(); } catch (_) { }
                reject(new DOMException(String(reason), "NotReadableError"));
            };
            const timer = setTimeout(() => fail("capture helper did not respond within 15s"), 15000);

            ws.onerror = () => fail("could not reach the capture helper on port 65124");

            ws.onopen = async () => {
                try {
                    peerConnection.addTransceiver("video", { direction: "recvonly" });
                    peerConnection.addTransceiver("audio", { direction: "recvonly" });
                    const offer = await peerConnection.createOffer();
                    await peerConnection.setLocalDescription(offer);
                    // Discord's requested size/frame rate is passed along for the
                    // log; the helper uses the quality picked in the QAM.
                    ws.send(JSON.stringify({ offer: { type: offer.type, sdp: offer.sdp }, constraints: constraints || null }));
                } catch (e) { fail(e); }
            };

            peerConnection.onicecandidate = (event) => {
                if (event.candidate && ws.readyState === WebSocket.OPEN)
                    ws.send(JSON.stringify({ ice: event.candidate }));
            };

            ws.onmessage = async (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.sdp) await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
                    else if (data.ice) await peerConnection.addIceCandidate(data.ice);
                    else if (data.error) fail(data.error);
                } catch (e) { console.warn("Deckcord: signalling error", e); }
            };

            peerConnection.onconnectionstatechange = () => {
                if (peerConnection.connectionState === "failed") fail("peer connection failed");
            };

            // ontrack instead of the deprecated onaddstream, which newer
            // Chromium builds (and so newer Steam clients) no longer fire.
            peerConnection.ontrack = (ev) => {
                const track = ev.track;
                track.stop = () => {
                    try { ws.send(JSON.stringify({ stop: "" })); } catch (_) { }
                    try { peerConnection.close(); } catch (_) { }
                    window.DECKCORD_RTC_STREAM = undefined;
                };
                stream.addTrack(track);
                if (!settled && stream.getVideoTracks().length > 0) {
                    settled = true;
                    clearTimeout(timer);
                    pending = null;
                    window.DECKCORD_RTC_STREAM = stream;
                    resolve(stream);
                }
            };
        });
        return pending;
    };

    window.navigator.mediaDevices.getDisplayMedia = getRTCStream;
})();
