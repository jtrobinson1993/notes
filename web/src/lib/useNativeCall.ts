// Reactive Vue wrapper around the native voice call wiring: exposes the engine's
// current state + peer as refs (updated via the engine's onState hook) and the
// control actions, so NativeCallPanel can bind them. Media is injected (the
// mediasoup-client SFU wrapper, once built).
import { ref, type Ref } from 'vue';
import { createNativeCall } from './nativeVoiceCall';
import type { CallMedia, CallState } from './voiceCall';

export interface UseNativeCall {
  state: Ref<CallState>;
  peerId: Ref<string | null>;
  start(): Promise<void>;
  stop(): void;
  placeCall(contactId: string): Promise<void>;
  accept(): Promise<void>;
  decline(): void;
  hangup(): Promise<void>;
}

export function useNativeCall(media: CallMedia): UseNativeCall {
  const state = ref<CallState>('idle');
  const peerId = ref<string | null>(null);
  const nc = createNativeCall(media, (s) => {
    state.value = s;
    // Read the peer at the moment of transition (the engine clears it only
    // after firing onState, so ring/dial states still carry it).
    peerId.value = nc.call.peerId;
  });
  return {
    state,
    peerId,
    start: nc.start,
    stop: nc.stop,
    placeCall: (contactId) => nc.call.placeCall(contactId),
    accept: () => nc.call.accept(),
    decline: () => nc.call.decline(),
    hangup: () => nc.call.hangup(),
  };
}
