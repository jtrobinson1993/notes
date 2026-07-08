import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  isNative: true,
  settingsGet: vi.fn(),
  vaultLock: vi.fn(),
  vaultStatus: vi.fn(),
  vaultUnlockKeychain: vi.fn(),
}));
vi.mock('../../src/lib/native', () => native);

import {
  applyRelockPolicy,
  gateState,
  lockVault,
  markUnlocked,
  teardownIdleRelock,
} from '../../src/lib/nativeVault';

beforeEach(() => {
  vi.resetAllMocks();
  native.isNative = true;
  native.vaultLock.mockResolvedValue(undefined);
  vi.useFakeTimers();
});

afterEach(() => {
  teardownIdleRelock();
  vi.useRealTimers();
});

describe('idle re-lock (D4 layer A)', () => {
  it('locks after the configured idle window', async () => {
    native.settingsGet.mockImplementation(async (key: string) =>
      key === 'relock.policy' ? 'on-idle' : '2',
    );
    gateState.value = 'ready';
    await applyRelockPolicy();

    await vi.advanceTimersByTimeAsync(2 * 60_000 + 1);
    expect(native.vaultLock).toHaveBeenCalled();
    expect(gateState.value).toBe('locked');
  });

  it('activity resets the idle timer', async () => {
    native.settingsGet.mockImplementation(async (key: string) =>
      key === 'relock.policy' ? 'on-idle' : '2',
    );
    gateState.value = 'ready';
    await applyRelockPolicy();

    await vi.advanceTimersByTimeAsync(90_000);
    window.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(90_000);
    expect(native.vaultLock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(31_000);
    expect(native.vaultLock).toHaveBeenCalled();
  });

  it('default policy (stay unlocked) never arms a timer', async () => {
    native.settingsGet.mockResolvedValue(null);
    gateState.value = 'ready';
    markUnlocked();
    await flushMicro();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(native.vaultLock).not.toHaveBeenCalled();
    expect(gateState.value).toBe('ready');
  });

  it('manual lockVault flips the gate and tears down the timer', async () => {
    native.settingsGet.mockImplementation(async (key: string) =>
      key === 'relock.policy' ? 'on-idle' : '5',
    );
    gateState.value = 'ready';
    await applyRelockPolicy();
    await lockVault();
    expect(gateState.value).toBe('locked');
    // Timer torn down — nothing fires later.
    native.vaultLock.mockClear();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(native.vaultLock).not.toHaveBeenCalled();
  });
});

async function flushMicro() {
  // markUnlocked kicks applyRelockPolicy without awaiting; drain microtasks
  // under fake timers.
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

