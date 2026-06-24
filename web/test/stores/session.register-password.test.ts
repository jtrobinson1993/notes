import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { WrappedKey } from '@notes/shared';

// Real crypto + Argon2id; the API is mocked as a dumb blob store. Passkey-less
// signup generates the master key client-side, wraps it under the password key,
// and sends the chosen handle (the login username); a later password login with
// that handle must recover the *same* MK.
const api = vi.hoisted(() => ({
  registerPassword: vi.fn(),
  passwordOptions: vi.fn(),
  passwordLogin: vi.fn(),
  me: vi.fn().mockResolvedValue({ user: { id: 'me' }, hasKeys: true, hasPassword: true }),
}));
vi.mock('../../src/lib/api', () => ({ api, ApiError: class extends Error {} }));
vi.mock('../../src/lib/idb', () => ({ clearCache: vi.fn() }));

import { useSessionStore } from '../../src/stores/session';

const HANDLE = 'Otter#0421';
const PASSWORD = 'a sufficiently long passphrase';
type RegBody = {
  inviteToken?: string;
  handle: string;
  publicKey: string;
  wrappedPrivateKey: WrappedKey;
  recoveryWrappedMk: WrappedKey;
  recoveryAuthHash: string;
  passwordSalt: string;
  passwordWrappedMk: WrappedKey;
  passwordAuthHash: string;
};
let saved: RegBody;

beforeEach(() => {
  setActivePinia(createPinia());
  sessionStorage.clear();
  vi.clearAllMocks();
  api.me.mockResolvedValue({ user: { id: 'me' }, hasKeys: true, hasPassword: true });
  api.registerPassword.mockImplementation(async (b: RegBody) => {
    saved = b;
    return { user: { id: 'me', handle: b.handle } };
  });
});
afterEach(() => sessionStorage.clear());

describe('session store — passkey-less signup', () => {
  it('registerWithPassword sends the chosen handle + wrapped material and unlocks', async () => {
    const s = useSessionStore();
    const recoveryCode = await s.registerWithPassword(HANDLE, PASSWORD, 'invite-tok');

    expect(api.registerPassword).toHaveBeenCalledOnce();
    expect(saved.handle).toBe(HANDLE);
    expect(saved.inviteToken).toBe('invite-tok');
    expect(typeof saved.passwordSalt).toBe('string');
    for (const k of ['wrappedPrivateKey', 'recoveryWrappedMk', 'passwordWrappedMk'] as const) {
      expect(saved[k]).toMatchObject({ salt: expect.any(String), iv: expect.any(String), ct: expect.any(String) });
    }
    expect(typeof saved.recoveryAuthHash).toBe('string');
    expect(typeof saved.passwordAuthHash).toBe('string');
    expect(typeof saved.publicKey).toBe('string');
    expect(recoveryCode.length).toBeGreaterThan(0);
    expect(s.unlocked).toBe(true);
    expect(s.hasKeys).toBe(true);
    expect(s.hasPassword).toBe(true);
    expect(s.user?.handle).toBe(HANDLE);
  });

  it('a later password login with the handle recovers the same master key', async () => {
    const signup = useSessionStore();
    await signup.registerWithPassword(HANDLE, PASSWORD);
    const mk = new Uint8Array(signup.mk!); // copy before the session is replaced

    // Fresh session: the server hands back the stored salt + wrapped MK.
    setActivePinia(createPinia());
    api.passwordOptions.mockResolvedValue({ salt: saved.passwordSalt });
    api.passwordLogin.mockResolvedValue({ user: { id: 'me' }, passwordWrappedMk: saved.passwordWrappedMk });
    const s = useSessionStore();
    await s.loginWithPassword(HANDLE, PASSWORD);

    expect(s.unlocked).toBe(true);
    expect(Buffer.from(s.mk!)).toEqual(Buffer.from(mk));
  });
});
