import { addEventListener, removeEventListener, call } from "@decky/api";
import { openMic, getMicId, listMics, setMicConnection } from "./audio";
import { note } from "./diag";

// QAM side of the microphone bridge.
//
// When Discord (in its browser view) asks for the microphone, the plugin
// backend relays the request here. This side opens the real microphone in
// Steam's UI, where that works, and answers with a local WebRTC connection
// carrying the audio. Non-trickle: wait for ICE gathering, then send one answer.

let pc: RTCPeerConnection | null = null;

export const micConnection = () => pc;

const iceDone = (p: RTCPeerConnection) =>
  new Promise<void>((resolve) => {
    if (p.iceGatheringState === "complete") return resolve();
    const t = setTimeout(resolve, 2000);
    p.addEventListener("icegatheringstatechange", () => {
      if (p.iceGatheringState === "complete") {
        clearTimeout(t);
        resolve();
      }
    });
  });

const deviceName = async () => {
  const id = getMicId();
  try {
    const m = (await listMics()).find((d) => d.id === id);
    return m?.label || "default microphone";
  } catch (_) {
    return "default microphone";
  }
};

async function answer(offer: { id: number; sdp: string }) {
  try {
    if (pc) {
      try {
        pc.close();
      } catch (_) {}
    }
    const p = new RTCPeerConnection({ iceServers: [] });
    pc = p;
    setMicConnection(p);
    p.onconnectionstatechange = () => {
      call("mic_report", p.connectionState, "").catch(() => {});
      note("Microphone bridge", p.connectionState !== "failed", p.connectionState);
    };
    let stream: MediaStream;
    try {
      stream = await openMic();
    } catch (e) {
      note("Saved microphone unavailable, using default", false, String(e));
      stream = await openMic("default");
    }
    stream.getTracks().forEach((t) => p.addTrack(t, stream));
    await p.setRemoteDescription({ type: "offer", sdp: offer.sdp });
    await p.setLocalDescription(await p.createAnswer());
    await iceDone(p);
    await call("mic_answer", { id: offer.id, sdp: p.localDescription!.sdp, device: await deviceName() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    note("Microphone bridge", false, msg);
    await call("mic_answer", { id: offer.id, error: `Steam couldn't open the microphone: ${msg}` }).catch(() => {});
  }
}

export function startMicBridge() {
  const listener = (data: any) => {
    if (data?.type === "offer") answer(data);
  };
  addEventListener("mic", listener);
  return () => {
    removeEventListener("mic", listener);
    try {
      pc?.close();
    } catch (_) {}
    pc = null;
    setMicConnection(null);
  };
}

export const micStatus = () => ({
  connection: pc?.connectionState ?? "none",
  tracks: pc ? pc.getSenders().map((s) => s.track?.readyState ?? "none") : [],
});
