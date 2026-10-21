// Microphone selection for the mic bridge.
//
// Discord's page can't open the microphone itself inside Steam, so the
// plugin captures it here (in Steam's UI context) and hands it to Discord
// over a local WebRTC link. Choosing a mic therefore happens here, not in
// Discord's settings, and can be switched live without reconnecting.

const KEY = "DISCORDIO_MIC_DEVICE";

// The live mic bridge connection (set by lib/mic.ts), for switching devices mid-call.
let micPc: RTCPeerConnection | null = null;
export const setMicConnection = (pc: RTCPeerConnection | null) => {
  micPc = pc;
};

export type Device = { id: string; label: string };

export const getMicId = (): string => {
  try {
    return localStorage.getItem(KEY) || "default";
  } catch (_) {
    return "default";
  }
};

export const listMics = async (): Promise<Device[]> => {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === "audioinput")
    .map((d, i) => ({ id: d.deviceId || "default", label: d.label || `Microphone ${i + 1}` }));
};

// Chromium's own voice processing, applied here where the microphone is
// really opened (Discord's toggles can't reach a bridged track). Off by
// default, as before: SteamOS may already process the mic.
export type Processing = { noiseSuppression: boolean; echoCancellation: boolean; autoGainControl: boolean };
const PKEY = "DISCORDIO_MIC_PROCESSING";
const PDEFAULT: Processing = { noiseSuppression: false, echoCancellation: false, autoGainControl: false };
export const getProcessing = (): Processing => {
  try {
    return { ...PDEFAULT, ...JSON.parse(localStorage.getItem(PKEY) || "{}") };
  } catch (_) {
    return { ...PDEFAULT };
  }
};

export const openMic = (id: string = getMicId()) =>
  navigator.mediaDevices.getUserMedia({
    video: false,
    audio: {
      ...(id && id !== "default" ? { deviceId: { exact: id } } : {}),
      ...getProcessing(),
    },
  });

export const setProcessing = async (patch: Partial<Processing>) => {
  try {
    localStorage.setItem(PKEY, JSON.stringify({ ...getProcessing(), ...patch }));
  } catch (_) {}
  await reopenLive(getMicId());
};

export const setMic = async (id: string) => {
  try {
    localStorage.setItem(KEY, id);
  } catch (_) {}
  await reopenLive(id);
};

// Reopen the mic with the current settings and swap it into a live call.
async function reopenLive(id: string) {
  // Swap the track on the live connection, if Discord is already using the mic.
  const pc = micPc;
  if (!pc || pc.connectionState === "closed") return;
  const stream = await openMic(id);
  const track = stream.getAudioTracks()[0];
  const sender = pc.getSenders().find((s) => s.track?.kind === "audio" || (!s.track && track));
  if (!sender) return;
  const old = sender.track;
  await sender.replaceTrack(track);
  try {
    old?.stop();
  } catch (_) {}
}
