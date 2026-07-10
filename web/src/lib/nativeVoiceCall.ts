// Wires the framework-agnostic VoiceCall engine to the native shell: its
// signaling seam (nativeVoice) drives call control, the mailbox drain surfaces
// incoming rings (DrainReport.calls), and the injected VoiceMedia produces/
// consumes SFU audio. This glue owns the *control plane*, so it is testable
// without WebRTC/mediasoup or the SFU server (media is injected).
//
// Control effects map to the voice IPCs: placeRing = relayCallOffer (seal a ring
// into the friend's mailbox — returns the call id + the minted frame key),
// join/leave = voiceJoin/voiceLeave (the call-id signaling room). Inbound
// `voice:frame` frames feed the engine (peer-join/leave) or the media layer (a
// `producer` signal → media.onProducer). Fresh rings from the drain become
// onIncomingRing; the call's frame key (caller's minted, callee's from the ring)
// is handed to `onFrameKey` so the app can arm insertable-streams E2EE.

import { relayCallOffer, voiceJoin, voiceLeave, type CallRing, type FriendSummary } from './native';
import { onMailIngested } from './nativeRelay';
import { onVoiceFrame, startVoiceSignaling, stopVoiceSignaling } from './nativeVoice';
import { VoiceCall, type CallState } from './voiceCall';
import type { VoiceMedia } from './voiceMedia';

/** A ring older than this is stale (the caller has long since given up) and is
 *  dropped rather than rung — matches the drain's "ephemeral ring" contract. */
export const RING_TTL_MS = 60_000;

export interface NativeCallOptions {
  onState?: (s: CallState) => void;
  /** The call's base64 frame key (caller's minted / callee's from the ring),
   *  handed over before media so the app can set the insertable-streams key. */
  onFrameKey?: (mediaKeyB64: string) => void;
  /** Injectable clock for deterministic staleness tests. */
  now?: () => number;
}

export interface NativeCall {
  call: VoiceCall;
  start(): Promise<void>;
  stop(): void;
}

/** Build a native-wired VoiceCall. `media` is the injected SFU media layer. */
export function createNativeCall(media: VoiceMedia, opts: NativeCallOptions = {}): NativeCall {
  const now = opts.now ?? Date.now;
  const call = new VoiceCall(media, {
    placeRing: async (contactId) => {
      const { callId, mediaKey } = await relayCallOffer(contactId);
      opts.onFrameKey?.(mediaKey); // caller arms its send frame key
      return callId;
    },
    join: (callId) => voiceJoin(callId),
    leave: (callId) => voiceLeave(callId),
    onState: opts.onState,
  });

  let offFrame: (() => void) | null = null;
  let offRing: (() => void) | null = null;

  async function start(): Promise<void> {
    await startVoiceSignaling();
    offFrame = onVoiceFrame((f) => {
      // The SFU announces a new producer over the signaling room → consume it.
      const payload = f.payload as { kind?: string; producerId?: string } | undefined;
      if (f.type === 'signal' && payload?.kind === 'producer' && payload.producerId) {
        void media.onProducer(payload.producerId);
        return;
      }
      void call.onFrame(f); // peer-join / peer-leave drive call control
    });
    offRing = onMailIngested((report) => {
      for (const ring of report.calls ?? []) {
        if (!isFresh(ring, now())) continue;
        opts.onFrameKey?.(ring.mediaKey); // callee arms the frame key from the ring
        call.onIncomingRing(ring.callId, ring.callerId);
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

/** Resolve a call peer's display label from its key — a contact id (outgoing
 *  call) or the caller's identity pubkey (incoming ring). Null if not a friend. */
export function peerNameFrom(peerId: string | null, friends: FriendSummary[]): string | null {
  if (!peerId) return null;
  for (const f of friends) {
    if (f.contact_id === peerId || f.identity_pub === peerId) return f.display_name || f.handle;
  }
  return null;
}
