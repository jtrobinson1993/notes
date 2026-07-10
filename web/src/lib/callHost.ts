// The app's single voice call, shared between the global call panel
// (NativeCallHost) and the "call" button in the chat surface. Lazily builds one
// useNativeCall over the real VoiceMedia, arming insertable-streams frame E2EE
// from the exchanged key: on either side receiving the call's frame key, install
// it under a fixed epoch (1:1 uses one key) and mark it the send epoch.
import { useNativeCall, type UseNativeCall } from './useNativeCall';
import { createNativeCallMedia, frameKeyBytes } from './nativeCallMedia';
import { setFrameKey, setSendEpoch } from './voiceTransform';

const CALL_EPOCH = 0; // a 1:1 call uses a single frame key

let host: UseNativeCall | null = null;

export function callHost(): UseNativeCall {
  if (!host) {
    host = useNativeCall(createNativeCallMedia(), (mediaKeyB64) => {
      setFrameKey(CALL_EPOCH, frameKeyBytes(mediaKeyB64));
      setSendEpoch(CALL_EPOCH);
    });
  }
  return host;
}

/** Test hook: drop the singleton so a fresh one is built next call. */
export function resetCallHost(): void {
  host = null;
}
