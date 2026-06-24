import { afterEach, describe, expect, it } from 'vitest';
import { makeApp, seedUser, type TestApp } from '../../test/helpers/server.js';
import { sha256b64 } from '../src/util.js';

// Passkey-less signup: the client generates the master key and uploads only
// wrapped blobs + auth-key hashes, plus the chosen handle (the login username).
// The server creates the account with exactly that handle (mirroring
// /api/me/keys + /api/me/password) and starts a session — no passkey. Gate is
// the same first-run-or-invite rule as /api/register/verify. Fake wrapped keys
// are fine here (the crypto round-trip is covered in the web/crypto tests).

const WK = { salt: 's', iv: 'i', ct: 'c' };
const AUTH_KEY = Buffer.from('a'.repeat(32)).toString('base64');
const AUTH_HASH = sha256b64(Buffer.from(AUTH_KEY, 'base64'));

const body = (handle: string, over: Record<string, unknown> = {}) => ({
  handle,
  publicKey: 'pk',
  wrappedPrivateKey: WK,
  recoveryWrappedMk: WK,
  recoveryAuthHash: 'rh',
  passwordSalt: 'SALT',
  passwordWrappedMk: WK,
  passwordAuthHash: AUTH_HASH,
  ...over,
});

let t: TestApp;
function inject(method: string, url: string, cookieHdr?: string, payload?: unknown) {
  return t.app.inject({ method: method as 'GET', url, headers: cookieHdr ? { cookie: cookieHdr } : {}, payload: payload as object });
}
afterEach(() => t.cleanup());

describe('POST /api/register/password (passkey-less signup)', () => {
  it('first-run signup creates an admin with the chosen handle, stores keys + password, starts a session', async () => {
    t = await makeApp();
    const handle = t.db.generateHandleOptions(1)[0]!;
    const res = await inject('POST', '/api/register/password', undefined, body(handle));
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeDefined(); // session started
    expect(res.json().user.handle).toBe(handle); // PM-saved username matches
    expect(t.db.userCount()).toBe(1);
    const created = t.db.getUser(res.json().user.id)!;
    expect(created.role).toBe('admin');
    expect(created.password_wrapped_mk).toBeTruthy();
    expect(created.recovery_wrapped_mk).toBeTruthy();

    // The freshly-created account can immediately log in with handle + password.
    const opts = await inject('POST', '/api/password/options', undefined, { handle });
    expect(opts.json().salt).toBe('SALT');
    const login = await inject('POST', '/api/password/login', undefined, { handle, authKey: AUTH_KEY });
    expect(login.statusCode).toBe(200);
    expect(login.json().passwordWrappedMk).toEqual(WK);
    expect(login.json().user.id).toBe(res.json().user.id);
  });

  it('invite signup creates a member and consumes the invite', async () => {
    t = await makeApp();
    const admin = seedUser(t.db, { handle: 'Wolf#0001' });
    t.db.createInvite({ id: 'i1', token: 'fresh', createdBy: admin, expiresAt: Date.now() + 3_600_000 });

    const res = await inject('POST', '/api/register/password', undefined, body(t.db.generateHandleOptions(1)[0]!, { inviteToken: 'fresh' }));
    expect(res.statusCode).toBe(200);
    expect(t.db.getUser(res.json().user.id)!.role).toBe('member');

    // Single-use: the same token can't sign up a second account.
    const again = await inject('POST', '/api/register/password', undefined, body(t.db.generateHandleOptions(1)[0]!, { inviteToken: 'fresh' }));
    expect(again.statusCode).toBe(403);
  });

  it('rejects signup without a valid invite once an account exists', async () => {
    t = await makeApp();
    seedUser(t.db, { handle: 'Wolf#0001' });
    const h = t.db.generateHandleOptions(1)[0]!;
    expect((await inject('POST', '/api/register/password', undefined, body(h))).statusCode).toBe(403);
    expect((await inject('POST', '/api/register/password', undefined, body(h, { inviteToken: 'nope' }))).statusCode).toBe(403);
  });

  it('rejects an invalid handle (400)', async () => {
    t = await makeApp();
    const res = await inject('POST', '/api/register/password', undefined, body('not a handle'));
    expect(res.statusCode).toBe(400);
  });

  it('rejects a handle that is already taken (409)', async () => {
    t = await makeApp();
    const admin = seedUser(t.db, { handle: 'Wolf#0001' });
    t.db.createInvite({ id: 'i1', token: 'fresh', createdBy: admin, expiresAt: Date.now() + 3_600_000 });
    const taken = t.db.generateHandleOptions(1)[0]!;
    seedUser(t.db, { handle: taken }); // occupy it
    const res = await inject('POST', '/api/register/password', undefined, body(taken, { inviteToken: 'fresh' }));
    expect(res.statusCode).toBe(409);
  });

  it('rejects a malformed payload (bad wrapped key)', async () => {
    t = await makeApp();
    const res = await inject('POST', '/api/register/password', undefined, body(t.db.generateHandleOptions(1)[0]!, { passwordWrappedMk: { nope: 1 } }));
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/register/handle-options', () => {
  it('returns candidate handles without auth', async () => {
    t = await makeApp();
    const res = await inject('GET', '/api/register/handle-options');
    expect(res.statusCode).toBe(200);
    const opts = res.json().options as string[];
    expect(Array.isArray(opts)).toBe(true);
    expect(opts.length).toBeGreaterThan(0);
  });
});
