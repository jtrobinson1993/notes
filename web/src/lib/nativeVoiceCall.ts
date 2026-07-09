// Wires the framework-agnostic VoiceCall engine to the native shell: its
// signaling seam (nativeVoice) drives call control, and the mailbox drain
// surfaces incoming rings (DrainReport.calls). The media layer (mediasoup-client
// SFU wrapper) is injected as `CallMedia` — this glue owns the *control plane*
// only, so it is fully testable without WebRTC/mediasoup or the SFU server.
//
// Control effects map to the voice IPCs: placeRing = relayCallOffer (seal a ring
// into the friend's mailbox), join/leave = voiceJoin/voiceLeave (the call-id
// signaling room). Inbound `voice:frame` peer-presence frames feed the engine;
// fresh rings from the drain become onIncomingRing.

import { relayCallOffer, voiceJoin, voiceLeave, type CallRing } from './native';
import { onMailIngested } from './nativeRelay';
import { onVoiceFrame, startVoiceSignaling, stopVoiceSignaling } from './nativeVoice';
import { VoiceCall, type CallMedia, type CallState } from './voiceCall';

/** A ring older than this is stale (the caller has long since given up) and is
 *  dropped rather than rung — matches the drain's "ephemeral ring" contract. */
export const RING_TTL_MS = 60_000;

export interface NativeCall {
  call: VoiceCall;
  start(): Promise<void>;
  stop(): void;
}

/**
 * Build a native-wired VoiceCall. `media` is the injected SFU media layer;
 * `onState` lets the UI observe call-state transitions. `now` is injectable for
 * deterministic staleness tests.
 */
export function createNativeCall(
  media: CallMedia,
  onState?: (s: CallState) => void,
  now: () => number = Date.now,
): NativeCall {
  const call = new VoiceCall(media, {
    placeRing: (contactId) => relayCallOffer(contactId),
    join: (callId) => voiceJoin(callId),
    leave: (callId) => voiceLeave(callId),
    onState,
  });

  let offFrame: (() => void) | null = null;
  let offRing: (() => void) | null = null;

  async function start(): Promise<void> {
    await startVoiceSignaling();
    offFrame = onVoiceFrame((f) => void call.onFrame(f));
    offRing = onMailIngested((report) => {
      for (const ring of report.calls ?? []) {
        if (isFresh(ring, now())) call.onIncomingRing(ring.callId, ring.callerId);
      }
    });
  }

  function stop(): void {
    offFrame?.();
    offRing?.();
    offFrame = null;
    offRing = null;
    void stopVoiceSignaling();
  }

  return { call, start, stop };
}

function isFresh(ring: CallRing, nowMs: number): boolean {
  return nowMs - ring.relayTs <= RING_TTL_MS;
}
