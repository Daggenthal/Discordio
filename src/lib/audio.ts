// Microphone selection for the mic bridge.
//
// Discord's page can't open the microphone itself inside Steam, so the
// plugin captures it here (in Steam's UI context) and hands it to Discord
// over a local WebRTC link. Choosing a mic therefore happens here, not in
// Discord's settings, and can be switched live without reconnecting.

const KEY = "DISCORDIO_MIC_DEVICE";

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

export const openMic = (id: string = getMicId()) =>
  navigator.mediaDevices.getUserMedia({
    video: false,
    audio: {
      ...(id && id !== "default" ? { deviceId: { exact: id } } : {}),
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

export const setMic = async (id: string) => {
  try {
    localStorage.setItem(KEY, id);
  } catch (_) {}
  // Swap the track on the live connection, if Discord is already using the mic.
  const pc: RTCPeerConnection | undefined = (window as any).DECKCORD?.MIC_PEER_CONNECTION;
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
};
