import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

// init() only needs meta + me; everything else (webauthn/crypto) is imported
// but not exercised by these tests.
const api = vi.hoisted(() => ({
  meta: vi.fn().mockResolvedValue({ needsSetup: false, appName: 'Notes' }),
  me: vi.fn().mockResolvedValue({ user: { id: 'me' }, hasKeys: true }),
}));
vi.mock('../../src/lib/api', () => ({ api, ApiError: class extends Error {} }));
vi.mock('../../src/lib/idb', () => ({ clearCache: vi.fn() }));

import { useSessionStore } from '../../src/stores/session';

beforeEach(() => {
  setActivePinia(createPinia());
  sessionStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('session store — master key lifetime (no inactivity auto-lock)', () => {
  it('setMk unlocks and mirrors the key into per-tab sessionStorage', () => {
    const s = useSessionStore();
    expect(s.unlocked).toBe(false);
    s.setMk(new Uint8Array(32).fill(7));
    expect(s.unlocked).toBe(true);
    expect(sessionStorage.getItem('notes:mk')).toBeTruthy();
  });

  it('does not auto-lock after a long idle period', async () => {
    const s = useSessionStore();
    await s.init(); // would have armed the old inactivity timer
    s.setMk(new Uint8Array(32).fill(7));

    vi.useFakeTimers();
    vi.advanceTimersByTime(60 * 60_000); // an hour of zero activity

    expect(s.unlocked).toBe(true);
    expect(sessionStorage.getItem('notes:mk')).toBeTruthy();
  });

  it('manual lock() clears the key from memory and sessionStorage', () => {
    const s = useSessionStore();
    s.setMk(new Uint8Array(32).fill(7));
    s.lock();
    expect(s.unlocked).toBe(false);
    expect(sessionStorage.getItem('notes:mk')).toBeNull();
  });

  it('no longer exposes auto-lock configuration', () => {
    const s = useSessionStore();
    expect('setAutoLock' in s).toBe(false);
    expect('autoLockMinutes' in s).toBe(false);
    expect('touch' in s).toBe(false);
  });

  it('restores the key from sessionStorage on init (in-tab reload)', async () => {
    const first = useSessionStore();
    first.setMk(new Uint8Array(32).fill(3));
    const stored = sessionStorage.getItem('notes:mk');
    expect(stored).toBeTruthy();

    // Simulate a fresh app instance in the same tab: new pinia, same sessionStorage.
    setActivePinia(createPinia());
    const reloaded = useSessionStore();
    expect(reloaded.unlocked).toBe(false);
    await reloaded.init();
    expect(reloaded.unlocked).toBe(true);
  });
});
