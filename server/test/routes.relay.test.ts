import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { makeApp, seedAuthedUser, type TestApp } from '../../test/helpers/server.js';
import { issueDeviceToken, verifyDeviceToken, DEVICE_TOKEN_TTL_SEC } from '../src/relayAuth.js';

let ctx: TestApp;
afterEach(async () => ctx && ctx.cleanup());

function deviceKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return { pubKey: spki.subarray(spki.length - 32).toString('base64'), privateKey };
}

async function enroll(cookie: string, pubKey: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/relay/devices',
    headers: { cookie },
    payload: { pubKey, name: 'test device' },
  });
  expect(res.statusCode).toBe(200);
  return res.json().deviceId as string;
}

async function getToken(pubKey: string, privateKey: ReturnType<typeof deviceKeys>['privateKey']) {
  const info = await ctx.app.inject({ method: 'GET', url: '/api/relay/info' });
  const fp = info.json().identityFingerprint as string;
  const challenge = await ctx.app.inject({ method: 'POST', url: '/api/relay/auth/challenge' });
  const nonce = challenge.json().nonce as string;
  const signature = edSign(null, Buffer.from(`${nonce}|${fp}`), privateKey).toString('base64');
  return ctx.app.inject({
    method: 'POST',
    url: '/api/relay/auth/token',
    payload: { pubKey, nonce, signature },
  });
}

describe('relay info + enrollment', () => {
  it('publishes a stable identity fingerprint without auth', async () => {
    ctx = await makeApp();
    const a = await ctx.app.inject({ method: 'GET', url: '/api/relay/info' });
    const b = await ctx.app.inject({ method: 'GET', url: '/api/relay/info' });
    expect(a.statusCode).toBe(200);
    expect(a.json().identityFingerprint).toBe(b.json().identityFingerprint);
    expect(a.json().apiVersion).toBe(1);
  });

  it('requires a session to enroll; enrollment is idempotent per key', async () => {
    ctx = await makeApp();
    const { pubKey } = deviceKeys();
    const anon = await ctx.app.inject({ method: 'POST', url: '/api/relay/devices', payload: { pubKey } });
    expect(anon.statusCode).toBe(401);

    const { cookie } = seedAuthedUser(ctx.db);
    const first = await enroll(cookie, pubKey);
    const second = await enroll(cookie, pubKey);
    expect(second).toBe(first);
  });

  it("rejects enrolling another account's device key", async () => {
    ctx = await makeApp();
    const { pubKey } = deviceKeys();
    const alice = seedAuthedUser(ctx.db);
    await enroll(alice.cookie, pubKey);
    const bob = seedAuthedUser(ctx.db, { handle: 'Other#0002' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/devices',
      headers: { cookie: bob.cookie },
      payload: { pubKey },
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects a malformed public key', async () => {
    ctx = await makeApp();
    const { cookie } = seedAuthedUser(ctx.db);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/devices',
      headers: { cookie },
      payload: { pubKey: 'dG9vLXNob3J0' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('challenge → token', () => {
  it('issues a working token for a valid signed nonce', async () => {
    ctx = await makeApp();
    const { cookie } = seedAuthedUser(ctx.db);
    const { pubKey, privateKey } = deviceKeys();
    const deviceId = await enroll(cookie, pubKey);

    const res = await getToken(pubKey, privateKey);
    expect(res.statusCode).toBe(200);
    expect(res.json().deviceId).toBe(deviceId);
    expect(res.json().expiresInSec).toBe(DEVICE_TOKEN_TTL_SEC);
    expect(verifyDeviceToken(res.json().token)).toBe(deviceId);
  });

  it('burns the nonce even on a bad signature, and rejects replays', async () => {
    ctx = await makeApp();
    const { cookie } = seedAuthedUser(ctx.db);
    const { pubKey } = deviceKeys();
    const other = deviceKeys(); // signature from the wrong key
    await enroll(cookie, pubKey);

    const info = await ctx.app.inject({ method: 'GET', url: '/api/relay/info' });
    const fp = info.json().identityFingerprint as string;
    const challenge = await ctx.app.inject({ method: 'POST', url: '/api/relay/auth/challenge' });
    const nonce = challenge.json().nonce as string;
    const badSig = edSign(null, Buffer.from(`${nonce}|${fp}`), other.privateKey).toString('base64');

    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/auth/token',
      payload: { pubKey, nonce, signature: badSig },
    });
    expect(bad.statusCode).toBe(401);

    // The nonce is spent: even a correct signature can't reuse it.
    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/auth/token',
      payload: { pubKey, nonce, signature: badSig },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toMatch(/nonce/);
  });

  it('rejects unknown and revoked devices', async () => {
    ctx = await makeApp();
    const { cookie } = seedAuthedUser(ctx.db);
    const { pubKey, privateKey } = deviceKeys();

    // Never enrolled.
    const unknown = await getToken(pubKey, privateKey);
    expect(unknown.statusCode).toBe(401);

    const deviceId = await enroll(cookie, pubKey);
    const revoke = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/relay/devices/${deviceId}`,
      headers: { cookie },
    });
    expect(revoke.statusCode).toBe(200);
    const revoked = await getToken(pubKey, privateKey);
    expect(revoked.statusCode).toBe(401);
  });
});

describe('device tokens', () => {
  it('round-trips and expires', () => {
    const { token } = issueDeviceToken('dev1');
    expect(verifyDeviceToken(token)).toBe('dev1');
    // Past expiry → invalid.
    expect(verifyDeviceToken(token, Date.now() + (DEVICE_TOKEN_TTL_SEC + 1) * 1000)).toBeNull();
    // Tampered → invalid.
    expect(verifyDeviceToken(token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))).toBeNull();
  });
});
