import { describe, expect, it, vi, beforeEach } from 'vitest';
import { VoiceCall, type CallEffects, type CallMedia, type CallSignal, type CallState } from '../../src/lib/voiceCall';

function fakeMedia(): CallMedia & { closed: number } {
  return {
    closed: 0,
    createOffer: vi.fn().mockResolvedValue({ sdp: 'OFFER' }),
    handleOffer: vi.fn().mockResolvedValue({ sdp: 'ANSWER' }),
    handleAnswer: vi.fn().mockResolvedValue(undefined),
    addIce: vi.fn().mockResolvedValue(undefined),
    close(this: { closed: number }) {
      this.closed += 1;
    },
  };
}

function fakeEffects(): CallEffects & { signals: { callId: string; payload: CallSignal }[]; states: CallState[] } {
  const signals: { callId: string; payload: CallSignal }[] = [];
  const states: CallState[] = [];
  return {
    signals,
    states,
    placeRing: vi.fn().mockResolvedValue('call-xyz'),
    join: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn().mockResolvedValue(undefined),
    sendSignal: vi.fn((callId: string, payload: CallSignal) => {
      signals.push({ callId, payload });
      return Promise.resolve();
    }),
    onState: (s: CallState) => states.push(s),
  };
}

let media: ReturnType<typeof fakeMedia>;
let fx: ReturnType<typeof fakeEffects>;
beforeEach(() => {
  media = fakeMedia();
  fx = fakeEffects();
});

describe('VoiceCall — caller side', () => {
  it('rings, offers on peer-join, applies the answer, and connects', async () => {
    const call = new VoiceCall(media, fx);
    await call.placeCall('contactA');
    expect(fx.placeRing).toHaveBeenCalledWith('contactA');
    expect(fx.join).toHaveBeenCalledWith('call-xyz');
    expect(call.state).toBe('dialing');

    // Callee appears → we send the offer and move to connecting.
    await call.onFrame({ type: 'peer-join', callId: 'call-xyz' });
    expect(media.createOffer).toHaveBeenCalled();
    expect(fx.signals[0]).toEqual({ callId: 'call-xyz', payload: { kind: 'offer', data: { sdp: 'OFFER' } } });
    expect(call.state).toBe('connecting');

    // Remote answer applied; ICE flows; media reports connected.
    await call.onFrame({ type: 'signal', callId: 'call-xyz', payload: { kind: 'answer', data: { sdp: 'ANS' } } });
    expect(media.handleAnswer).toHaveBeenCalledWith({ sdp: 'ANS' });
    await call.onFrame({ type: 'signal', callId: 'call-xyz', payload: { kind: 'ice', data: 'cand-1' } });
    expect(media.addIce).toHaveBeenCalledWith('cand-1');
    call.onMediaConnected();
    expect(call.state).toBe('connected');
  });

  it('does not offer into an empty room (waits for peer-join)', async () => {
    const call = new VoiceCall(media, fx);
    await call.placeCall('contactA');
    expect(media.createOffer).not.toHaveBeenCalled();
  });

  it('forwards local ICE candidates to the peer', async () => {
    const call = new VoiceCall(media, fx);
    await call.placeCall('contactA');
    await call.localIce('my-cand');
    expect(fx.signals.at(-1)).toEqual({ callId: 'call-xyz', payload: { kind: 'ice', data: 'my-cand' } });
  });
});

describe('VoiceCall — callee side', () => {
  it('rings in, answers the offer, and connects', async () => {
    const call = new VoiceCall(media, fx);
    call.onIncomingRing('call-abc', 'caller-pub');
    expect(call.state).toBe('ringing');
    expect(call.peerId).toBe('caller-pub');

    await call.accept();
    expect(fx.join).toHaveBeenCalledWith('call-abc');
    expect(call.state).toBe('connecting');

    await call.onFrame({ type: 'signal', callId: 'call-abc', payload: { kind: 'offer', data: { sdp: 'O' } } });
    expect(media.handleOffer).toHaveBeenCalledWith({ sdp: 'O' });
    expect(fx.signals.at(-1)).toEqual({ callId: 'call-abc', payload: { kind: 'answer', data: { sdp: 'ANSWER' } } });

    call.onMediaConnected();
    expect(call.state).toBe('connected');
  });

  it('declines a ring without joining or leaving', async () => {
    const call = new VoiceCall(media, fx);
    call.onIncomingRing('call-abc', 'caller-pub');
    call.decline();
    expect(call.state).toBe('ended');
    expect(fx.join).not.toHaveBeenCalled();
    expect(fx.leave).not.toHaveBeenCalled();
    expect(media.closed).toBe(1);
  });
});

describe('VoiceCall — lifecycle guards', () => {
  it('rejects a second placeCall while busy', async () => {
    const call = new VoiceCall(media, fx);
    await call.placeCall('contactA');
    await expect(call.placeCall('contactB')).rejects.toThrow(/already in a call/);
  });

  it('ignores an incoming ring while already in a call (busy)', async () => {
    const call = new VoiceCall(media, fx);
    await call.placeCall('contactA');
    call.onIncomingRing('call-other', 'someone');
    expect(call.state).toBe('dialing'); // unchanged
    expect(call.callId).toBe('call-xyz');
  });

  it('hangup leaves the room, closes media, and is idempotent', async () => {
    const call = new VoiceCall(media, fx);
    await call.placeCall('contactA');
    await call.hangup();
    expect(fx.leave).toHaveBeenCalledWith('call-xyz');
    expect(media.closed).toBe(1);
    expect(call.state).toBe('ended');
    await call.hangup(); // no-op the second time
    expect(fx.leave).toHaveBeenCalledTimes(1);
  });

  it('ends the call when the peer leaves', async () => {
    const call = new VoiceCall(media, fx);
    await call.placeCall('contactA');
    await call.onFrame({ type: 'peer-leave', callId: 'call-xyz' });
    expect(call.state).toBe('ended');
    expect(media.closed).toBe(1);
  });

  it('ignores frames addressed to a different call id', async () => {
    const call = new VoiceCall(media, fx);
    await call.placeCall('contactA');
    await call.onFrame({ type: 'peer-join', callId: 'SOMEONE-ELSE' });
    expect(media.createOffer).not.toHaveBeenCalled();
    expect(call.state).toBe('dialing');
  });
});
