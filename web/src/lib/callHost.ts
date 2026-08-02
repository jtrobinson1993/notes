// The app's single voice call, shared between the global call panel
// (NativeCallHost) and the "call" button in the chat surface. Lazily builds one
// useNativeCall over the real VoiceMedia, arming insertable-streams frame E2EE
// from the exchanged key: on either side receiving the call's frame key, install
// it under a fixed epoch (1:1 uses one key) and mark it the send epoch.
import { useNativeCall, type UseNativeCall } from './useNativeCall';
import { createNativeCallMedia, frameKeyBytes } from './nativeCallMedia';
import { setFrameKey, setSendEpoch, voiceE2eeSupported } from './voiceTransform';
import { toastError } from './toast';

const CALL_EPOCH = 0; // a 1:1 call uses a single frame key

let host: UseNativeCall | null = null;

/**
 * Fail closed: no call may run without frame E2EE.
 *
 * The relay's SFU forwards audio it must never be able to decode, so a webview
 * without WebRTC Encoded Transform cannot hold a call at all — we refuse rather
 * than silently downgrade to plaintext Opus, which would look identical to the
 * user. Returns false (having toasted) when the call must not proceed.
 */
function e2eeReady(): boolean {
  if (voiceE2eeSupported()) return true;
  toastError('VOICE_E2EE_UNSUPPORTED');
  return false;
}

export function callHost(): UseNativeCall {
  if (!host) {
    const inner = useNativeCall(createNativeCallMedia(), (mediaKeyB64) => {
      setFrameKey(CALL_EPOCH, frameKeyBytes(mediaKeyB64));
      setSendEpoch(CALL_EPOCH);
    });
    // Gate the two entry points that would put audio on the wire. `decline` and
    // `hangup` stay ungated — ending a call must always work.
    host = {
      ...inner,
      placeCall: async (contactId) => {
        if (!e2eeReady()) return;
        await inner.placeCall(contactId);
      },
      accept: async () => {
        // Decline the ring too, so the caller stops waiting on an answer that
        // can never come rather than ringing out.
        if (!e2eeReady()) {
          inner.decline();
          return;
        }
        await inner.accept();
      },
    };
  }
  return host;
}

/**
 * Hang up and unwire the call, if one was ever built. Called when the vault
 * re-locks: a live call's frame key is derived from state the master key
 * protects, so no call may outlive it. A no-op when no call host exists yet, so
 * locking never spins up mic/mediasoup machinery just to tear it down.
 */
export function teardownCallHost(): void {
  if (!host) return;
  void host.hangup().catch(() => {});
  host.stop();
}

/** Test hook: drop the singleton so a fresh one is built next call. */
export function resetCallHost(): void {
  host = null;
}
