import { describe, expect, it, vi, beforeEach } from 'vitest';

const native = vi.hoisted(() => ({
  isNative: true,
  voiceJoin: vi.fn(),
  voiceSignal: vi.fn(),
  voiceLeave: vi.fn(),
}));
vi.mock('../../src/lib/native', () => native);

const evt = vi.hoisted(() => ({
  handler: null as null | ((e: { payload: unknown }) => void),
  unlisten: vi.fn(),
  listen: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    evt.handler = cb;
    return evt.listen(name, cb);
  },
}));

import {
  onVoiceFrame,
  startVoiceSignaling,
  stopVoiceSignaling,
  type VoiceFrame,
} from '../../src/lib/nativeVoice';

beforeEach(async () => {
  await stopVoiceSignaling();
  vi.clearAllMocks();
  native.isNative = true;
  evt.handler = null;
  evt.listen.mockResolvedValue(evt.unlisten);
});

describe('nativeVoice signaling seam', () => {
  it('fans an inbound voice:frame out to all subscribers', async () => {
    await startVoiceSignaling();
    expect(evt.listen).toHaveBeenCalledWith('voice:frame', expect.any(Function));

    const a: VoiceFrame[] = [];
    const b: VoiceFrame[] = [];
    const offA = onVoiceFrame((f) => a.push(f));
    onVoiceFrame((f) => b.push(f));

    const frame: VoiceFrame = { type: 'signal', callId: 'c1', payload: 'sealed' };
    evt.handler?.({ payload: frame });
    expect(a).toEqual([frame]);
    expect(b).toEqual([frame]);

    // Unsubscribing stops delivery to that listener only.
    offA();
    evt.handler?.({ payload: { type: 'peer-leave', callId: 'c1' } });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });

  it('subscribes at most once even if started repeatedly', async () => {
    await startVoiceSignaling();
    await startVoiceSignaling();
    expect(evt.listen).toHaveBeenCalledTimes(1);
  });

  it('does not subscribe outside the native shell', async () => {
    native.isNative = false;
    await startVoiceSignaling();
    expect(evt.listen).not.toHaveBeenCalled();
  });

  it('tears down the listener on stop', async () => {
    await startVoiceSignaling();
    await stopVoiceSignaling();
    expect(evt.unlisten).toHaveBeenCalled();
  });
});
