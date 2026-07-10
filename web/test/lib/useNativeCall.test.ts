import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { CallState } from '../../src/lib/voiceCall';

// A fake VoiceCall whose peerId we can steer, plus a captured onState hook.
const hoisted = vi.hoisted(() => ({
  onState: null as null | ((s: CallState) => void),
  call: {
    peerId: null as string | null,
    placeCall: vi.fn().mockResolvedValue(undefined),
    accept: vi.fn().mockResolvedValue(undefined),
    decline: vi.fn(),
    hangup: vi.fn().mockResolvedValue(undefined),
  },
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn(),
}));

vi.mock('../../src/lib/nativeVoiceCall', () => ({
  createNativeCall: (_media: unknown, opts?: { onState?: (s: CallState) => void }) => {
    hoisted.onState = opts?.onState ?? null;
    return { call: hoisted.call, start: hoisted.start, stop: hoisted.stop };
  },
}));

import { useNativeCall } from '../../src/lib/useNativeCall';
import type { VoiceMedia } from '../../src/lib/voiceMedia';

const media: VoiceMedia = {
  join: vi.fn().mockResolvedValue(undefined),
  close: vi.fn(),
  onProducer: vi.fn().mockResolvedValue(undefined),
};

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.onState = null;
  hoisted.call.peerId = null;
});

describe('useNativeCall', () => {
  it('reflects engine state transitions (and the peer at transition time) reactively', () => {
    const vc = useNativeCall(media);
    expect(vc.state.value).toBe('idle');

    hoisted.call.peerId = 'bob-pub';
    hoisted.onState?.('ringing');
    expect(vc.state.value).toBe('ringing');
    expect(vc.peerId.value).toBe('bob-pub');

    hoisted.onState?.('connected');
    expect(vc.state.value).toBe('connected');
  });

  it('delegates actions and lifecycle to the underlying wiring', async () => {
    const vc = useNativeCall(media);
    await vc.start();
    expect(hoisted.start).toHaveBeenCalled();

    await vc.placeCall('contactA');
    expect(hoisted.call.placeCall).toHaveBeenCalledWith('contactA');
    await vc.accept();
    expect(hoisted.call.accept).toHaveBeenCalled();
    vc.decline();
    expect(hoisted.call.decline).toHaveBeenCalled();
    await vc.hangup();
    expect(hoisted.call.hangup).toHaveBeenCalled();

    vc.stop();
    expect(hoisted.stop).toHaveBeenCalled();
  });
});
