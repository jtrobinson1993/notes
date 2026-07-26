// Assembles the real v8 VoiceMedia for the app: createCallMedia wired to the
// Rust-IPC SFU control (nativeSfuControl), a real mediasoup-client Device,
// getUserMedia mic, insertable-streams frame E2EE (voiceTransform), and remote
// tracks played through <audio>. Browser-runtime only — the orchestration it
// drives is unit-tested in voiceMedia.test with fakes; this file just injects
// the real deps, so it's exercised by e2e / manual runs.
import { Device } from 'mediasoup-client';
import { createCallMedia, type MsDevice, type VoiceMedia } from './voiceMedia';
import { nativeSfuControl } from './nativeSfu';
import { decryptReceiver, encryptSender } from './voiceTransform';

const MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/** Decode a base64 (standard) 32-byte frame key to bytes. */
export function frameKeyBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Play a remote peer's audio track (kept alive by a detached <audio>). */
function playRemote(track: MediaStreamTrack): void {
  const audio = new Audio();
  audio.srcObject = new MediaStream([track]);
  audio.autoplay = true;
  void audio.play().catch(() => {}); // autoplay policy: harmless if deferred
}

/** Build the app VoiceMedia. Frame E2EE hooks are ALWAYS attached: there is no
 *  unencrypted mode. If the webview lacks insertable streams, encryptSender
 *  throws and the call fails rather than streaming plaintext to the SFU —
 *  callers gate on voiceE2eeSupported() first (lib/callHost) so the user gets
 *  the VOICE_E2EE_UNSUPPORTED toast instead of a raw failure. */
export function createNativeCallMedia(): VoiceMedia {
  return createCallMedia({
    control: nativeSfuControl,
    createDevice: () => new Device() as unknown as MsDevice,
    getMicTrack: async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
      return stream.getAudioTracks()[0]!;
    },
    onRemoteTrack: playRemote,
    encryptSender,
    decryptReceiver,
  });
}
