import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fail-closed voice: a webview without WebRTC Encoded Transform cannot hold a
// call, because the SFU would otherwise receive plaintext Opus while the UI
// looked like an ordinary encrypted call. These tests pin all three layers of
// that guard, since each on its own used to fail OPEN.

const transform = vi.hoisted(() => ({
  supported: true,
  voiceE2eeSupported: vi.fn(() => transform.supported),
  setFrameKey: vi.fn(),
  setSendEpoch: vi.fn(),
}));
vi.mock('../../src/lib/voiceTransform', () => ({
  voiceE2eeSupported: transform.voiceE2eeSupported,
  setFrameKey: transform.setFrameKey,
  setSendEpoch: transform.setSendEpoch,
  encryptSender: vi.fn(),
  decryptReceiver: vi.fn(),
}));

const media = vi.hoisted(() => ({ createNativeCallMedia: vi.fn(() => ({})), frameKeyBytes: vi.fn() }));
vi.mock('../../src/lib/nativeCallMedia', () => media);

const call = vi.hoisted(() => ({
  placeCall: vi.fn().mockResolvedValue(undefined),
  accept: vi.fn().mockResolvedValue(undefined),
  decline: vi.fn(),
  hangup: vi.fn().mockResolvedValue(undefined),
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('../../src/lib/useNativeCall', () => ({
  useNativeCall: () => ({ state: { value: 'idle' }, peerId: { value: null }, ...call }),
}));

import { callHost, resetCallHost } from '../../src/lib/callHost';
import { resetToasts, toasts } from '../../src/lib/toast';

beforeEach(() => {
  vi.clearAllMocks();
  resetCallHost();
  resetToasts();
  transform.supported = true;
});
afterEach(() => resetToasts());

describe('callHost fails closed without frame E2EE', () => {
  it('refuses to place a call and tells the user why', async () => {
    transform.supported = false;

    await callHost().placeCall('contact-1');

    expect(call.placeCall).not.toHaveBeenCalled();
    expect(toasts.value).toHaveLength(1);
    expect(toasts.value[0]!.code).toBe('VOICE_E2EE_UNSUPPORTED');
    // The user sees a sentence, never the bare code.
    expect(toasts.value[0]!.message).not.toBe('VOICE_E2EE_UNSUPPORTED');
    expect(toasts.value[0]!.message.length).toBeGreaterThan(10);
  });

  it('refuses to answer, and declines so the caller is not left ringing', async () => {
    transform.supported = false;

    await callHost().accept();

    expect(call.accept).not.toHaveBeenCalled();
    expect(call.decline).toHaveBeenCalled();
    expect(toasts.value[0]!.code).toBe('VOICE_E2EE_UNSUPPORTED');
  });

  it('still allows hanging up — ending a call must never be blocked', async () => {
    transform.supported = false;
    await callHost().hangup();
    expect(call.hangup).toHaveBeenCalled();
  });

  it('places and answers normally when E2EE is available', async () => {
    const host = callHost();
    await host.placeCall('contact-1');
    await host.accept();

    expect(call.placeCall).toHaveBeenCalledWith('contact-1');
    expect(call.accept).toHaveBeenCalled();
    expect(call.decline).not.toHaveBeenCalled();
    expect(toasts.value).toHaveLength(0);
  });
});
