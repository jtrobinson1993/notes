// Native-shell voice signaling seam (spec/voice.md § v8, client half).
//
// The Rust core holds the /api/relay/voice WebSocket and emits inbound peer
// frames as `voice:frame` Tauri events; here we listen and fan them out to
// subscribers (the call UI). Outbound actions (join/signal/leave) and placing a
// ring (relayCallOffer) go straight through the IPC wrappers in native.ts.
//
// Frame payloads (SDP/ICE inside `signal`) are opaque here — they are E2E-sealed
// between the call peers; this seam only routes them. The actual WebRTC/media
// wiring (getUserMedia + RTCPeerConnection) is a follow-up that consumes these
// frames; see LOCAL-FIRST-LOG.

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isNative, voiceJoin, voiceLeave, voiceSignal } from './native';

/** One inbound signaling frame from the relay (already filtered by the core to
 *  the forwardable set). `payload` is present only on `signal` frames. */
export interface VoiceFrame {
  type: 'hello' | 'joined' | 'peer-join' | 'peer-leave' | 'signal' | 'error';
  callId?: string;
  peers?: number;
  payload?: unknown;
  error?: string;
}

const frameListeners = new Set<(f: VoiceFrame) => void>();

/** Subscribe to inbound voice signaling frames. Returns an unsubscribe fn. */
export function onVoiceFrame(cb: (f: VoiceFrame) => void): () => void {
  frameListeners.add(cb);
  return () => {
    frameListeners.delete(cb);
  };
}

let unlisten: UnlistenFn | null = null;

/** Start forwarding `voice:frame` events to subscribers (idempotent). */
export async function startVoiceSignaling(): Promise<void> {
  if (!isNative || unlisten) return;
  unlisten = await listen<VoiceFrame>('voice:frame', (e) => {
    for (const cb of frameListeners) cb(e.payload);
  });
}

/** Tear down the listener (e.g. on relay switch / sign-out). */
export async function stopVoiceSignaling(): Promise<void> {
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
}

// Re-export the outbound call actions so the call UI has one import surface.
export { voiceJoin, voiceLeave, voiceSignal };
