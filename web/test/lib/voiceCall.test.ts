import { describe, expect, it, vi, beforeEach } from 'vitest';
import { VoiceCall, type CallEffects, type CallMedia, type CallState } from '../../src/lib/voiceCall';

function fakeMedia(): CallMedia & { closed: number; joins: string[] } {
  const joins: string[] = [];
  return {
    closed: 0,
    joins,
    join: vi.fn((callId: string) => {
      joins.push(callId);
      return Promise.resolve();
    }),
    close(this: { closed: number }) {
      this.closed += 1;
    },
  };
}

function fakeEffects(): CallEffects & { states: CallState[] } {
  const states: CallState[] = [];
  return {
    states,
    placeRing: vi.fn().mockResolvedValue('call-xyz'),
    join: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn().mockResolvedValue(undefined),
    onState: (s: CallState) => states.push(s),
  };
}

let media: ReturnType<typeof fakeMedia>;
let fx: ReturnType<typeof fakeEffects>;
beforeEach(() => {
  media = fakeMedia();
  fx = fakeEffects();
});

describe('VoiceCall — caller side (SFU)', () => {
  it('rings, and joins the SFU only once the callee appears', async () => {
    const call = new VoiceCall(media, fx);
    await call.placeCall('contactA');
    expect(fx.placeRing).toHaveBeenCalledWith('contactA');
    expect(fx.join).toHaveBeenCalledWith('call-xyz'); // signaling room
    expect(call.state).toBe('dialing');
    expect(media.join).not.toHaveBeenCalled(); // mic not hot while ringing

    await call.onFrame({ type: 'peer-join', callId: 'call-xyz' });
    expect(media.join).toHaveBeenCalledWith('call-xyz'); // now join the SFU
    expect(call.state).toBe('connecting');

    call.onMediaConnected();
    expect(call.state).toBe('connected');
  });

  it('ignores a peer-join for a different call id', async () => {
    const call = new VoiceCall(media, fx);
    await call.placeCall('contactA');
    await call.onFrame({ type: 'peer-join', callId: 'SOMEONE-ELSE' });
    expect(media.join).not.toHaveBeenCalled();
    expect(call.state).toBe('dialing');
  });
});

describe('VoiceCall — callee side (SFU)', () => {
  it('rings in, and on accept joins signaling + the SFU', async () => {
    const call = new VoiceCall(media, fx);
    call.onIncomingRing('call-abc', 'caller-pub');
    expect(call.state).toBe('ringing');
    expect(call.peerId).toBe('caller-pub');

    await call.accept();
    expect(fx.join).toHaveBeenCalledWith('call-abc'); // signaling room
    expect(media.join).toHaveBeenCalledWith('call-abc'); // SFU
    expect(call.state).toBe('connecting');

    call.onMediaConnected();
    expect(call.state).toBe('connected');
  });

  it('declines a ring without joining signaling or the SFU', async () => {
    const call = new VoiceCall(media, fx);
    call.onIncomingRing('call-abc', 'caller-pub');
    call.decline();
    expect(call.state).toBe('ended');
    expect(fx.join).not.toHaveBeenCalled();
    expect(media.join).not.toHaveBeenCalled();
    expect(media.closed).toBe(0); // never joined media → nothing to close
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
    expect(call.state).toBe('dialing');
    expect(call.callId).toBe('call-xyz');
  });

  it('hangup releases joined media, leaves the room, and is idempotent', async () => {
    const call = new VoiceCall(media, fx);
    await call.placeCall('contactA');
    await call.onFrame({ type: 'peer-join', callId: 'call-xyz' }); // joins SFU
    await call.hangup();
    expect(media.closed).toBe(1);
    expect(fx.leave).toHaveBeenCalledWith('call-xyz');
    expect(call.state).toBe('ended');
    await call.hangup();
    expect(fx.leave).toHaveBeenCalledTimes(1);
  });

  it('does not close media on hangup if the SFU was never joined', async () => {
    const call = new VoiceCall(media, fx);
    await call.placeCall('contactA'); // dialing, no media yet
    await call.hangup();
    expect(media.closed).toBe(0);
    expect(fx.leave).toHaveBeenCalledWith('call-xyz');
  });

  it('ends the call when the peer leaves', async () => {
    const call = new VoiceCall(media, fx);
    await call.placeCall('contactA');
    await call.onFrame({ type: 'peer-join', callId: 'call-xyz' });
    await call.onFrame({ type: 'peer-leave', callId: 'call-xyz' });
    expect(call.state).toBe('ended');
    expect(media.closed).toBe(1);
  });
});
