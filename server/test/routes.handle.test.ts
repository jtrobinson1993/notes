import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authCookie, makeApp, seedUser, type TestApp } from '../../test/helpers/server.js';
import { sha256b64 } from '../src/util.js';

// Changing the handle is step-up-authenticated for password accounts: the handle
// is the password-login username, so a password account must re-prove its password
// (the same auth key as login) to change it — stopping someone with the unlocked
// session from changing the handle and locking the owner out. Passkey-only
// accounts have no password and skip the check.

const WK = { salt: 's', iv: 'i', ct: 'c' };
const AUTH_KEY = Buffer.from('a'.repeat(32)).toString('base64');
const AUTH_HASH = sha256b64(Buffer.from(AUTH_KEY, 'base64'));

let t: TestApp;
let me: string;
let cookie: string;
let newHandle: string;

function inject(method: string, url: string, cookieHdr?: string, payload?: unknown) {
  return t.app.inject({ method: method as 'GET', url, headers: cookieHdr ? { cookie: cookieHdr } : {}, payload: payload as object });
}
const addPassword = () =>
  inject('PUT', '/api/me/password', cookie, { salt: 'SALT', passwordWrappedMk: WK, passwordAuthHash: AUTH_HASH });

beforeEach(async () => {
  t = await makeApp();
  me = seedUser(t.db, { handle: 'Wolf#0001' });
  cookie = authCookie(t.db, me);
  // A valid, currently-untaken handle (word from the curated list + 4 digits).
  newHandle = t.db.generateHandleOptions(1)[0]!;
});
afterEach(() => t.cleanup());

describe('PUT /api/handle step-up auth', () => {
  it('lets a passkey-only account change its handle without a password proof', async () => {
    const res = await inject('PUT', '/api/handle', cookie, { handle: newHandle });
    expect(res.statusCode).toBe(200);
    expect(res.json().handle).toBe(newHandle);
    expect(t.db.getUser(me)!.handle).toBe(newHandle);
  });

  it('requires the auth key for a password account', async () => {
    await addPassword();
    const res = await inject('PUT', '/api/handle', cookie, { handle: newHandle });
    expect(res.statusCode).toBe(401);
    expect(t.db.getUser(me)!.handle).toBe('Wolf#0001'); // unchanged
  });

  it('rejects a password account that sends a wrong auth key', async () => {
    await addPassword();
    const bad = Buffer.from('b'.repeat(32)).toString('base64');
    const res = await inject('PUT', '/api/handle', cookie, { handle: newHandle, authKey: bad });
    expect(res.statusCode).toBe(401);
    expect(t.db.getUser(me)!.handle).toBe('Wolf#0001');
  });

  it('changes the handle for a password account with the correct auth key', async () => {
    await addPassword();
    const res = await inject('PUT', '/api/handle', cookie, { handle: newHandle, authKey: AUTH_KEY });
    expect(res.statusCode).toBe(200);
    expect(res.json().handle).toBe(newHandle);
    expect(t.db.getUser(me)!.handle).toBe(newHandle);
  });

  it('rejects an invalid handle regardless of auth', async () => {
    const res = await inject('PUT', '/api/handle', cookie, { handle: 'not a handle' });
    expect(res.statusCode).toBe(400);
  });
});
