import { describe, it, expect, afterEach } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto';
import { makeApp, seedAuthedUser, type TestApp } from '../../test/helpers/server.js';

let ctx: TestApp;
afterEach(async () => ctx && ctx.cleanup());

async function deviceBearer(cookie: string): Promise<string> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const pubKey = spki.subarray(spki.length - 32).toString('base64');
  await ctx.app.inject({ method: 'POST', url: '/api/relay/devices', headers: { cookie }, payload: { pubKey } });
  const info = await ctx.app.inject({ method: 'GET', url: '/api/relay/info' });
  const challenge = await ctx.app.inject({ method: 'POST', url: '/api/relay/auth/challenge' });
  const nonce = challenge.json().nonce as string;
  const signature = edSign(
    null,
    Buffer.from(`${nonce}|${info.json().identityFingerprint as string}`),
    privateKey,
  ).toString('base64');
  const token = await ctx.app.inject({
    method: 'POST',
    url: '/api/relay/auth/token',
    payload: { pubKey, nonce, signature },
  });
  return `Bearer ${token.json().token as string}`;
}

describe('escrow (D15)', () => {
  it('uploads with a device token and fetches with the matching auth key', async () => {
    ctx = await makeApp();
    const alice = seedAuthedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice.cookie);

    const authKey = randomBytes(32);
    const authHash = createHash('sha256').update(authKey).digest('base64url');
    const payload = JSON.stringify({ v: 1, wrappedMkPassword: 'opaque' });

    const anon = await ctx.app.inject({ method: 'PUT', url: '/api/relay/escrow', payload: { payload } });
    expect(anon.statusCode).toBe(401);

    const up = await ctx.app.inject({
      method: 'PUT',
      url: '/api/relay/escrow',
      headers: { authorization: bearer },
      payload: { payload, passwordAuthHash: authHash, recoveryAuthHash: null },
    });
    expect(up.statusCode).toBe(200);

    const fetch = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/escrow/fetch',
      payload: { handle: 'Alice#0001', authKind: 'password', authKey: authKey.toString('base64') },
    });
    expect(fetch.statusCode).toBe(200);
    expect(fetch.json().payload).toBe(payload);
  });

  it('refuses uniformly: wrong key, wrong kind, unknown handle', async () => {
    ctx = await makeApp();
    const alice = seedAuthedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice.cookie);
    const authKey = randomBytes(32);
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/relay/escrow',
      headers: { authorization: bearer },
      payload: {
        payload: '{}',
        passwordAuthHash: createHash('sha256').update(authKey).digest('base64url'),
      },
    });

    const wrongKey = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/escrow/fetch',
      payload: { handle: 'Alice#0001', authKind: 'password', authKey: randomBytes(32).toString('base64') },
    });
    // recovery hash was never registered → same refusal.
    const wrongKind = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/escrow/fetch',
      payload: { handle: 'Alice#0001', authKind: 'recovery', authKey: authKey.toString('base64') },
    });
    const noUser = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/escrow/fetch',
      payload: { handle: 'Ghost#0000', authKind: 'password', authKey: authKey.toString('base64') },
    });
    expect(wrongKey.statusCode).toBe(401);
    expect(wrongKind.statusCode).toBe(401);
    expect(noUser.statusCode).toBe(401);
    expect(wrongKey.json()).toEqual(noUser.json());
  });

  it('re-upload replaces the bundle', async () => {
    ctx = await makeApp();
    const alice = seedAuthedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice.cookie);
    const authKey = randomBytes(32);
    const authHash = createHash('sha256').update(authKey).digest('base64url');
    for (const version of ['one', 'two']) {
      await ctx.app.inject({
        method: 'PUT',
        url: '/api/relay/escrow',
        headers: { authorization: bearer },
        payload: { payload: version, passwordAuthHash: authHash },
      });
    }
    const fetch = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/escrow/fetch',
      payload: { handle: 'Alice#0001', authKind: 'password', authKey: authKey.toString('base64') },
    });
    expect(fetch.json().payload).toBe('two');
  });
});
