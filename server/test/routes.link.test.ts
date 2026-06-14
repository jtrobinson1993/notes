import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { authCookie, makeApp, seedUser, type TestApp } from '../../test/helpers/server.js';

const SEALED = { epk: 'AAAA', iv: 'BBBB', ct: 'CCCC' };
const DEVICE_PK = 'ZGV2aWNlLXB1YmxpYy1rZXk='; // any base64-ish string; shape only

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(() => t.cleanup());

function inject(opts: { method: any; url: string; cookie?: string; payload?: unknown }) {
  return t.app.inject({
    method: opts.method,
    url: opts.url,
    headers: opts.cookie ? { cookie: opts.cookie } : {},
    payload: opts.payload as object | undefined,
  });
}

async function initLink(devicePublicKey = DEVICE_PK): Promise<{ code: string; secret: string }> {
  const res = await inject({ method: 'POST', url: '/api/link/init', payload: { devicePublicKey } });
  expect(res.statusCode).toBe(200);
  return { code: res.json().code as string, secret: res.json().secret as string };
}

function sessionCookieFrom(res: { cookies: { name: string; value: string }[] }): string {
  const c = res.cookies.find((x) => x.name === 'notes_session')!;
  return `notes_session=${c.value}`;
}

describe('device link — init', () => {
  it('returns a code + secret', async () => {
    const { code, secret } = await initLink();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/); // 8 unambiguous uppercase chars
    expect(secret.length).toBeGreaterThan(20);
  });

  it('rejects a missing / oversized devicePublicKey', async () => {
    expect((await inject({ method: 'POST', url: '/api/link/init', payload: {} })).statusCode).toBe(400);
    expect((await inject({ method: 'POST', url: '/api/link/init', payload: { devicePublicKey: 'x'.repeat(200) } })).statusCode).toBe(400);
  });
});

describe('device link — auth on the logged-in side', () => {
  it('GET /:code and seal require authentication', async () => {
    const { code } = await initLink();
    expect((await inject({ method: 'GET', url: `/api/link/${code}` })).statusCode).toBe(401);
    expect((await inject({ method: 'POST', url: `/api/link/${code}/seal`, payload: { sealedMk: SEALED } })).statusCode).toBe(401);
  });

  it('GET /:code returns the new device public key to an authed user', async () => {
    const { code } = await initLink();
    const cookie = authCookie(t.db, seedUser(t.db));
    const res = await inject({ method: 'GET', url: `/api/link/${code}`, cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ devicePublicKey: DEVICE_PK, sealed: false });
  });
});

describe('device link — full flow', () => {
  it('seal → poll → complete issues a working session for the sealing account', async () => {
    const owner = seedUser(t.db, { username: 'owner', displayName: 'Owner' });
    const ownerCookie = authCookie(t.db, owner);
    const { code, secret } = await initLink();

    // Before sealing, the new device sees "pending".
    const pending = await inject({ method: 'POST', url: `/api/link/${code}/poll`, payload: { secret } });
    expect(pending.json()).toEqual({ status: 'pending' });

    // Logged-in device seals MK to the new device.
    const seal = await inject({ method: 'POST', url: `/api/link/${code}/seal`, cookie: ownerCookie, payload: { sealedMk: SEALED } });
    expect(seal.statusCode).toBe(200);

    // New device polls and gets the sealed blob + the target account.
    const polled = await inject({ method: 'POST', url: `/api/link/${code}/poll`, payload: { secret } });
    expect(polled.json().status).toBe('sealed');
    expect(polled.json().sealedMk).toEqual(SEALED);
    expect(polled.json().user).toMatchObject({ id: owner, username: 'owner', displayName: 'Owner' });

    // New device completes → gets a session.
    const done = await inject({ method: 'POST', url: `/api/link/${code}/complete`, payload: { secret } });
    expect(done.statusCode).toBe(200);
    expect(done.json().user).toMatchObject({ id: owner });

    // The issued session authenticates as the sealing account.
    const me = await inject({ method: 'GET', url: '/api/me', cookie: sessionCookieFrom(done) });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.id).toBe(owner);
  });
});

describe('device link — single-use & abuse resistance', () => {
  it('seal is single-use (a second seal is rejected)', async () => {
    const a = authCookie(t.db, seedUser(t.db));
    const b = authCookie(t.db, seedUser(t.db));
    const { code } = await initLink();
    expect((await inject({ method: 'POST', url: `/api/link/${code}/seal`, cookie: a, payload: { sealedMk: SEALED } })).statusCode).toBe(200);
    // A racing second seal (even by a different account) loses.
    expect((await inject({ method: 'POST', url: `/api/link/${code}/seal`, cookie: b, payload: { sealedMk: SEALED } })).statusCode).toBe(409);
  });

  it('poll requires the correct secret', async () => {
    const owner = authCookie(t.db, seedUser(t.db));
    const { code } = await initLink();
    await inject({ method: 'POST', url: `/api/link/${code}/seal`, cookie: owner, payload: { sealedMk: SEALED } });
    expect((await inject({ method: 'POST', url: `/api/link/${code}/poll`, payload: { secret: 'wrong' } })).statusCode).toBe(404);
    expect((await inject({ method: 'POST', url: `/api/link/${code}/poll`, payload: {} })).statusCode).toBe(400);
  });

  it('complete before sealing is 409, and the link is consumed after completing', async () => {
    const owner = authCookie(t.db, seedUser(t.db));
    const { code, secret } = await initLink();
    expect((await inject({ method: 'POST', url: `/api/link/${code}/complete`, payload: { secret } })).statusCode).toBe(409);
    await inject({ method: 'POST', url: `/api/link/${code}/seal`, cookie: owner, payload: { sealedMk: SEALED } });
    expect((await inject({ method: 'POST', url: `/api/link/${code}/complete`, payload: { secret } })).statusCode).toBe(200);
    // Single-use: it's gone now.
    expect((await inject({ method: 'POST', url: `/api/link/${code}/complete`, payload: { secret } })).statusCode).toBe(404);
    expect((await inject({ method: 'POST', url: `/api/link/${code}/poll`, payload: { secret } })).statusCode).toBe(404);
  });

  it('an expired link is not found', async () => {
    const owner = authCookie(t.db, seedUser(t.db));
    t.db.createDeviceLink({
      id: 'lnk',
      code: 'EXPIRED1',
      secretHash: createHash('sha256').update('s').digest('base64'),
      devicePublicKey: DEVICE_PK,
      expiresAt: Date.now() - 1,
    });
    expect((await inject({ method: 'GET', url: '/api/link/EXPIRED1', cookie: owner })).statusCode).toBe(404);
    expect((await inject({ method: 'POST', url: '/api/link/EXPIRED1/poll', payload: { secret: 's' } })).statusCode).toBe(404);
  });
});
