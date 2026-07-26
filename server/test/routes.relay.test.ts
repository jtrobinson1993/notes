import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { enrollDevice as enrollRelayDevice, makeRelayApp, seedUser, type TestApp } from '../../test/helpers/server.js';
import { issueDeviceToken, verifyDeviceToken, DEVICE_TOKEN_TTL_SEC, fingerprintB64url } from '../src/relayAuth.js';

let ctx: TestApp;
afterEach(async () => ctx && ctx.cleanup());

function deviceKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return { pubKey: spki.subarray(spki.length - 32).toString('base64'), privateKey };
}

/** Enroll a device key for a user. The session-gated `POST /api/relay/devices`
 * transport is gone (accounts register via `/api/relay/register`, devices are
 * managed by the relay CLI), so enrollment goes straight at the DB accessor —
 * which is also where the key-binding guards now live. */
function enroll(userId: string, pubKey: string): string {
  const id = fingerprintB64url(Buffer.from(pubKey, 'base64'));
  const got = ctx.db.enrollRelayDevice(userId, id, pubKey, 'test device');
  expect(got).not.toBeNull();
  return got as string;
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
    ctx = await makeRelayApp();
    const a = await ctx.app.inject({ method: 'GET', url: '/api/relay/info' });
    const b = await ctx.app.inject({ method: 'GET', url: '/api/relay/info' });
    expect(a.statusCode).toBe(200);
    expect(a.json().identityFingerprint).toBe(b.json().identityFingerprint);
    expect(a.json().apiVersion).toBe(1);
  });

  it('no longer exposes a session-gated enrollment surface', async () => {
    ctx = await makeRelayApp();
    const { pubKey } = deviceKeys();
    // The legacy bootstrap endpoints are gone outright — not merely unauthorized.
    for (const m of ['GET', 'POST'] as const) {
      const res = await ctx.app.inject({ method: m, url: '/api/relay/devices', payload: { pubKey } });
      expect(res.statusCode).toBe(404);
    }
  });

  it('enrollment is idempotent per key', async () => {
    ctx = await makeRelayApp();
    const { pubKey } = deviceKeys();
    const alice = seedUser(ctx.db);
    expect(enroll(alice, pubKey)).toBe(enroll(alice, pubKey));
  });

  it("refuses to bind another account's device key", async () => {
    ctx = await makeRelayApp();
    const { pubKey } = deviceKeys();
    const alice = seedUser(ctx.db);
    const deviceId = enroll(alice, pubKey);
    // Bob must not be able to claim a key already bound to Alice: the accessor
    // returns null rather than re-pointing the device at him.
    const bob = seedUser(ctx.db, { handle: 'Other#0002' });
    expect(ctx.db.enrollRelayDevice(bob, deviceId, pubKey, 'stolen')).toBeNull();
    expect(ctx.db.getRelayDeviceByPubkey(pubKey)?.userId).toBe(alice);
  });

  it('rejects a malformed public key at registration', async () => {
    ctx = await makeRelayApp({ registrationMode: 'public' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/register',
      payload: { pubKey: 'dG9vLXNob3J0' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('challenge \u2192 token', () => {
  it('issues a working token for a valid signed nonce', async () => {
    ctx = await makeRelayApp();
    const alice = seedUser(ctx.db);
    const { pubKey, privateKey } = deviceKeys();
    const deviceId = enroll(alice, pubKey);

    const res = await getToken(pubKey, privateKey);
    expect(res.statusCode).toBe(200);
    expect(res.json().deviceId).toBe(deviceId);
    expect(res.json().expiresInSec).toBe(DEVICE_TOKEN_TTL_SEC);
    expect(verifyDeviceToken(res.json().token)).toBe(deviceId);
  });

  it('burns the nonce even on a bad signature, and rejects replays', async () => {
    ctx = await makeRelayApp();
    const alice = seedUser(ctx.db);
    const { pubKey } = deviceKeys();
    const other = deviceKeys(); // signature from the wrong key
    enroll(alice, pubKey);

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
    ctx = await makeRelayApp();
    const alice = seedUser(ctx.db);
    const { pubKey, privateKey } = deviceKeys();

    // Never enrolled.
    const unknown = await getToken(pubKey, privateKey);
    expect(unknown.statusCode).toBe(401);

    const deviceId = enroll(alice, pubKey);
    expect(ctx.db.revokeRelayDevice(alice, deviceId)).toBe(true);
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
