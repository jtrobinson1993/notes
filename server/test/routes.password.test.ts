import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authCookie, makeApp, seedUser, type TestApp } from '../../test/helpers/server.js';
import { sha256b64 } from '../src/util.js';

// Password fallback: the server only ever stores the Argon2id salt, MK wrapped by
// the password-derived key, and the sha256 of the password auth key — it never
// sees the password. Login mirrors recovery (handle + auth key, rate-limited).

const WK = { salt: 's', iv: 'i', ct: 'c' };
// A fake "auth key" the client would derive; the server stores its sha256.
const AUTH_KEY = Buffer.from('a'.repeat(32)).toString('base64');
const AUTH_HASH = sha256b64(Buffer.from(AUTH_KEY, 'base64'));

let t: TestApp;
let me: string;
let cookie: string;

function inject(method: string, url: string, cookieHdr?: string, payload?: unknown) {
  return t.app.inject({ method: method as 'GET', url, headers: cookieHdr ? { cookie: cookieHdr } : {}, payload: payload as object });
}
const setPassword = (c = cookie, body: unknown = { salt: 'SALT', passwordWrappedMk: WK, passwordAuthHash: AUTH_HASH }) =>
  inject('PUT', '/api/me/password', c, body);

beforeEach(async () => {
  t = await makeApp();
  me = seedUser(t.db, { handle: 'Wolf#0001' });
  cookie = authCookie(t.db, me);
});
afterEach(() => t.cleanup());

describe('password fallback routes', () => {
  it('PUT stores the password and /api/me reports hasPassword', async () => {
    expect((await inject('GET', '/api/me', cookie)).json().hasPassword).toBe(false);
    expect((await setPassword()).statusCode).toBe(200);
    expect((await inject('GET', '/api/me', cookie)).json().hasPassword).toBe(true);
  });

  it('PUT rejects a malformed wrapped key', async () => {
    const res = await setPassword(cookie, { salt: 'SALT', passwordWrappedMk: { nope: 1 }, passwordAuthHash: AUTH_HASH });
    expect(res.statusCode).toBe(400);
  });

  it('PUT requires auth', async () => {
    const res = await inject('PUT', '/api/me/password', undefined, { salt: 'SALT', passwordWrappedMk: WK, passwordAuthHash: AUTH_HASH });
    expect(res.statusCode).toBe(401);
  });

  it('options returns the stored salt for a user with a password', async () => {
    await setPassword();
    const res = await inject('POST', '/api/password/options', undefined, { handle: 'Wolf#0001' });
    expect(res.statusCode).toBe(200);
    expect(res.json().salt).toBe('SALT');
  });

  it('options returns a salt even for an unknown handle (no enumeration)', async () => {
    const res = await inject('POST', '/api/password/options', undefined, { handle: 'Ghost#9999' });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().salt).toBe('string');
    expect(res.json().salt.length).toBeGreaterThan(0);
  });

  it('login succeeds with the right auth key and returns the wrapped MK', async () => {
    await setPassword();
    const res = await inject('POST', '/api/password/login', undefined, { handle: 'Wolf#0001', authKey: AUTH_KEY });
    expect(res.statusCode).toBe(200);
    expect(res.json().passwordWrappedMk).toEqual(WK);
    expect(res.json().user.id).toBe(me);
    expect(res.headers['set-cookie']).toBeDefined(); // a session was started
  });

  it('login fails with a wrong auth key', async () => {
    await setPassword();
    const bad = Buffer.from('b'.repeat(32)).toString('base64');
    const res = await inject('POST', '/api/password/login', undefined, { handle: 'Wolf#0001', authKey: bad });
    expect(res.statusCode).toBe(401);
  });

  it('login fails for a user with no password set', async () => {
    const res = await inject('POST', '/api/password/login', undefined, { handle: 'Wolf#0001', authKey: AUTH_KEY });
    expect(res.statusCode).toBe(401);
  });

  it('DELETE clears the password', async () => {
    await setPassword();
    expect((await inject('DELETE', '/api/me/password', cookie)).statusCode).toBe(200);
    expect((await inject('GET', '/api/me', cookie)).json().hasPassword).toBe(false);
    const res = await inject('POST', '/api/password/login', undefined, { handle: 'Wolf#0001', authKey: AUTH_KEY });
    expect(res.statusCode).toBe(401);
  });
});
