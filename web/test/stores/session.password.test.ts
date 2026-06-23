import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { WrappedKey } from '@notes/shared';

// Real crypto + Argon2id; only the API is mocked, acting as a dumb blob store so
// we exercise the full client round-trip (setPassword wraps MK → loginWithPassword
// re-derives the key and unwraps it).
const api = vi.hoisted(() => ({
  meta: vi.fn().mockResolvedValue({ needsSetup: false, appName: 'Notes' }),
  me: vi.fn().mockResolvedValue({ user: { id: 'me' }, hasKeys: true, hasPassword: true }),
  passwordSet: vi.fn(),
  passwordOptions: vi.fn(),
  passwordLogin: vi.fn(),
}));
vi.mock('../../src/lib/api', () => ({ api, ApiError: class extends Error {} }));
vi.mock('../../src/lib/idb', () => ({ clearCache: vi.fn() }));

import { useSessionStore } from '../../src/stores/session';

const PASSWORD = 'a sufficiently long passphrase';
let saved: { salt: string; passwordWrappedMk: WrappedKey; passwordAuthHash: string };

beforeEach(() => {
  setActivePinia(createPinia());
  sessionStorage.clear();
  vi.clearAllMocks();
  api.passwordSet.mockImplementation(async (body) => { saved = body; });
});
afterEach(() => sessionStorage.clear());

describe('session store — password fallback round-trip', () => {
  it('setPassword wraps MK and uploads salt + wrapped key + auth hash', async () => {
    const s = useSessionStore();
    s.setMk(new Uint8Array(32).fill(7));
    await s.setPassword(PASSWORD);

    expect(api.passwordSet).toHaveBeenCalledOnce();
    expect(typeof saved.salt).toBe('string');
    expect(saved.passwordWrappedMk).toMatchObject({ salt: expect.any(String), iv: expect.any(String), ct: expect.any(String) });
    expect(typeof saved.passwordAuthHash).toBe('string');
    expect(s.hasPassword).toBe(true);
  });

  it('setPassword requires an unlocked session', async () => {
    const s = useSessionStore();
    await expect(s.setPassword(PASSWORD)).rejects.toThrow(/unlock/);
  });

  it('loginWithPassword recovers the same master key', async () => {
    const mk = new Uint8Array(32).fill(7);
    const setter = useSessionStore();
    setter.setMk(mk);
    await setter.setPassword(PASSWORD);

    // Fresh session: the server hands back the stored salt + wrapped MK.
    setActivePinia(createPinia());
    api.passwordOptions.mockResolvedValue({ salt: saved.salt });
    api.passwordLogin.mockResolvedValue({ user: { id: 'me' }, passwordWrappedMk: saved.passwordWrappedMk });
    const s = useSessionStore();
    await s.loginWithPassword('Wolf#0001', PASSWORD);

    expect(s.unlocked).toBe(true);
    expect(Buffer.from(s.mk!)).toEqual(Buffer.from(mk));
    expect(s.hasPassword).toBe(true);
  });

  it('loginWithPassword fails to unwrap with the wrong password', async () => {
    const setter = useSessionStore();
    setter.setMk(new Uint8Array(32).fill(7));
    await setter.setPassword(PASSWORD);

    setActivePinia(createPinia());
    api.passwordOptions.mockResolvedValue({ salt: saved.salt });
    api.passwordLogin.mockResolvedValue({ user: { id: 'me' }, passwordWrappedMk: saved.passwordWrappedMk });
    const s = useSessionStore();
    await expect(s.loginWithPassword('Wolf#0001', 'the wrong long passphrase')).rejects.toBeDefined();
    expect(s.unlocked).toBe(false);
  });
});
