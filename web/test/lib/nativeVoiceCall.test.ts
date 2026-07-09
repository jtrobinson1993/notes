import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { CallRing, DrainReport } from '../../src/lib/native';
import type { VoiceFrame } from '../../src/lib/nativeVoice';

const native = vi.hoisted(() => ({
  relayCallOffer: vi.fn().mockResolvedValue('call-xyz'),
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
import type { CallMedia } from '../../src/lib/voiceCall';

function media(): CallMedia & { closed: number; joins: string[] } {
  const joins: string[] = [];
  return {
    closed: 0,
    joins,
    join: (id) => (joins.push(id), Promise.resolve()),
    close(this: { closed: number }) {
      this.closed += 1;
    },
  };
}

const ring = (over: Partial<CallRing> = {}): CallRing => ({ callId: 'call-abc', callerId: 'caller', relayTs: 0, ...over });
const report = (calls: CallRing[]): DrainReport => ({ ingested: 0, acked: 0, buffered: 0, friends: 0, calls });

beforeEach(() => {
  vi.clearAllMocks();
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

  it('places a call through the ring + signaling IPCs', async () => {
    const nc = createNativeCall(media());
    await nc.start();
    await nc.call.placeCall('contactA');
    expect(native.relayCallOffer).toHaveBeenCalledWith('contactA');
    expect(native.voiceJoin).toHaveBeenCalledWith('call-xyz');
    expect(nc.call.state).toBe('dialing');
  });

  it('rings on a fresh drained call and joins the SFU on accept', async () => {
    const m = media();
    const nc = createNativeCall(m, undefined, () => 1000);
    await nc.start();
    relay.ingestCb!(report([ring({ callId: 'call-abc', callerId: 'bob', relayTs: 1000 })]));
    expect(nc.call.state).toBe('ringing');
    expect(nc.call.peerId).toBe('bob');

    await nc.call.accept();
    expect(native.voiceJoin).toHaveBeenCalledWith('call-abc');
    expect(m.joins).toEqual(['call-abc']);
    expect(nc.call.state).toBe('connecting');
  });

  it('drops a stale ring (older than the TTL) without ringing', async () => {
    const nc = createNativeCall(media(), undefined, () => RING_TTL_MS + 2);
    await nc.start();
    relay.ingestCb!(report([ring({ relayTs: 1 })])); // age = RING_TTL_MS+1 > TTL
    expect(nc.call.state).toBe('idle');
  });

  it('feeds inbound peer-leave frames to the engine (ends an active call)', async () => {
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
