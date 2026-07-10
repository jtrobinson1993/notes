import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { CallRing, DrainReport } from '../../src/lib/native';
import type { VoiceFrame } from '../../src/lib/nativeVoice';
import type { VoiceMedia } from '../../src/lib/voiceMedia';

const native = vi.hoisted(() => ({
  relayCallOffer: vi.fn().mockResolvedValue({ callId: 'call-xyz', mediaKey: 'KEY-CALLER' }),
  voiceJoin: vi.fn().mockResolvedValue(undefined),
  voiceLeave: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/lib/native', () => native);

const relay = vi.hoisted(() => ({
  ingestCb: null as null | ((r: DrainReport) => void),
  onMailIngested: vi.fn(),
}));
vi.mock('../../src/lib/nativeRelay', () => ({
  onMailIngested: (cb: (r: DrainReport) => void) => {
    relay.ingestCb = cb;
    return relay.onMailIngested(cb);
  },
}));

const voice = vi.hoisted(() => ({
  frameCb: null as null | ((f: VoiceFrame) => void),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  unsub: vi.fn(),
}));
vi.mock('../../src/lib/nativeVoice', () => ({
  startVoiceSignaling: () => voice.start(),
  stopVoiceSignaling: () => voice.stop(),
  onVoiceFrame: (cb: (f: VoiceFrame) => void) => {
    voice.frameCb = cb;
    return voice.unsub;
  },
}));

import { createNativeCall, RING_TTL_MS } from '../../src/lib/nativeVoiceCall';

function media(): VoiceMedia & { closed: number; joins: string[]; producers: string[] } {
  const joins: string[] = [];
  const producers: string[] = [];
  return {
    closed: 0,
    joins,
    producers,
    join: (id) => (joins.push(id), Promise.resolve()),
    onProducer: (id) => (producers.push(id), Promise.resolve()),
    close(this: { closed: number }) {
      this.closed += 1;
    },
  };
}

const ring = (over: Partial<CallRing> = {}): CallRing => ({
  callId: 'call-abc',
  callerId: 'caller',
  relayTs: 0,
  mediaKey: 'KEY-RING',
  ...over,
});
const report = (calls: CallRing[]): DrainReport => ({ ingested: 0, acked: 0, buffered: 0, friends: 0, calls });

beforeEach(() => {
  vi.clearAllMocks();
  native.relayCallOffer.mockResolvedValue({ callId: 'call-xyz', mediaKey: 'KEY-CALLER' });
  relay.ingestCb = null;
  voice.frameCb = null;
});

describe('nativeVoiceCall wiring', () => {
  it('subscribes to signaling + rings on start, unsubscribes on stop', async () => {
    const nc = createNativeCall(media());
    await nc.start();
    expect(voice.start).toHaveBeenCalled();
    expect(voice.frameCb).toBeTypeOf('function');
    expect(relay.ingestCb).toBeTypeOf('function');

    nc.stop();
    expect(voice.unsub).toHaveBeenCalled();
    expect(voice.stop).toHaveBeenCalled();
  });

  it('places a call, arming the caller frame key from the ring result', async () => {
    const keys: string[] = [];
    const nc = createNativeCall(media(), { onFrameKey: (k) => keys.push(k) });
    await nc.start();
    await nc.call.placeCall('contactA');
    expect(native.relayCallOffer).toHaveBeenCalledWith('contactA');
    expect(native.voiceJoin).toHaveBeenCalledWith('call-xyz');
    expect(keys).toEqual(['KEY-CALLER']); // caller's minted frame key
    expect(nc.call.state).toBe('dialing');
  });

  it('rings on a fresh drained call, arming the callee frame key, and joins on accept', async () => {
    const keys: string[] = [];
    const m = media();
    const nc = createNativeCall(m, { now: () => 1000, onFrameKey: (k) => keys.push(k) });
    await nc.start();
    relay.ingestCb!(report([ring({ callId: 'call-abc', callerId: 'bob', relayTs: 1000, mediaKey: 'KEY-RING' })]));
    expect(nc.call.state).toBe('ringing');
    expect(nc.call.peerId).toBe('bob');
    expect(keys).toEqual(['KEY-RING']); // callee's frame key from the sealed ring

    await nc.call.accept();
    expect(native.voiceJoin).toHaveBeenCalledWith('call-abc');
    expect(m.joins).toEqual(['call-abc']);
    expect(nc.call.state).toBe('connecting');
  });

  it('drops a stale ring (older than the TTL) without ringing or a frame key', async () => {
    const keys: string[] = [];
    const nc = createNativeCall(media(), { now: () => RING_TTL_MS + 2, onFrameKey: (k) => keys.push(k) });
    await nc.start();
    relay.ingestCb!(report([ring({ relayTs: 1 })])); // age = RING_TTL_MS+1 > TTL
    expect(nc.call.state).toBe('idle');
    expect(keys).toEqual([]);
  });

  it('routes a producer signal to media.onProducer (not the call engine)', async () => {
    const m = media();
    const nc = createNativeCall(m);
    await nc.start();
    voice.frameCb!({ type: 'signal', callId: 'call-xyz', payload: { kind: 'producer', producerId: 'prod-7' } });
    await Promise.resolve();
    expect(m.producers).toEqual(['prod-7']);
  });

  it('feeds inbound peer-join/leave frames to the engine', async () => {
    const m = media();
    const nc = createNativeCall(m);
    await nc.start();
    await nc.call.placeCall('contactA');
    voice.frameCb!({ type: 'peer-join', callId: 'call-xyz' });
    await Promise.resolve();
    expect(m.joins).toEqual(['call-xyz']); // joined SFU on peer-join
    voice.frameCb!({ type: 'peer-leave', callId: 'call-xyz' });
    await Promise.resolve();
    expect(nc.call.state).toBe('ended');
  });
});
