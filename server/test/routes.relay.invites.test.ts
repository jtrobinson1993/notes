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

const hash = (t: string) => createHash('sha256').update(t).digest('base64url');
const envelopeB64 = () => Buffer.from('sealed friend-accept').toString('base64');

describe('friend invites (D4b)', () => {
  it('mint requires a device token', async () => {
    ctx = await makeApp();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/invites',
      payload: { tokenHash: hash('t') },
    });
    expect(res.statusCode).toBe(401);
  });

  it('redeem drops one sealed envelope into the inviter mailbox, then is one-time', async () => {
    ctx = await makeApp();
    const alice = seedAuthedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice.cookie);
    const token = randomBytes(24).toString('base64url');

    const mint = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/invites',
      headers: { authorization: bearer },
      payload: { tokenHash: hash(token) },
    });
    expect(mint.statusCode).toBe(200);
    expect(mint.json().expiresAt).toBeGreaterThan(Date.now());

    // Bob (unauthenticated — the token is the only capability) redeems.
    const redeem = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/invites/redeem',
      payload: { token, envelope: envelopeB64() },
    });
    expect(redeem.statusCode).toBe(200);
    expect(redeem.json().relayTs).toBeGreaterThan(0);

    // The envelope landed in Alice's mailbox.
    const fetched = await ctx.app.inject({
      method: 'GET',
      url: '/api/relay/mailbox',
      headers: { authorization: bearer },
    });
    expect(fetched.json()).toHaveLength(1);
    expect(fetched.json()[0].envelope).toBe(envelopeB64());

    // A second redeem of the same token is refused (one-time) and enqueues nothing.
    const again = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/invites/redeem',
      payload: { token, envelope: envelopeB64() },
    });
    expect(again.statusCode).toBe(401);
  });

  it('refuses unknown / expired tokens uniformly (no enumeration)', async () => {
    ctx = await makeApp();
    const alice = seedAuthedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice.cookie);

    // Expired invite (mint directly with a past expiry).
    const expiredToken = randomBytes(24).toString('base64url');
    ctx.db.mintRelayInvite(hash(expiredToken), alice.id, Date.now() - 1000);

    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/invites/redeem',
      payload: { token: 'never-minted', envelope: envelopeB64() },
    });
    const expired = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/invites/redeem',
      payload: { token: expiredToken, envelope: envelopeB64() },
    });
    expect(unknown.statusCode).toBe(401);
    expect(expired.statusCode).toBe(401);
    expect(unknown.json()).toEqual(expired.json());
    // Alice's mailbox stayed empty.
    const fetched = await ctx.app.inject({
      method: 'GET',
      url: '/api/relay/mailbox',
      headers: { authorization: bearer },
    });
    expect(fetched.json()).toHaveLength(0);
  });

  it('validity check is non-consuming and reflects used/expired state', async () => {
    ctx = await makeApp();
    const alice = seedAuthedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice.cookie);
    const token = randomBytes(24).toString('base64url');
    await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/invites',
      headers: { authorization: bearer },
      payload: { tokenHash: hash(token) },
    });

    const check = () =>
      ctx.app.inject({ method: 'POST', url: '/api/relay/invites/check', payload: { token } });

    expect((await check()).json().valid).toBe(true);
    expect((await check()).json().valid).toBe(true); // non-consuming

    await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/invites/redeem',
      payload: { token, envelope: envelopeB64() },
    });
    expect((await check()).json().valid).toBe(false); // used
  });

  it('caps the invite TTL', async () => {
    ctx = await makeApp();
    const alice = seedAuthedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice.cookie);
    const mint = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/invites',
      headers: { authorization: bearer },
      payload: { tokenHash: hash('tok'), expiresInSec: 999 * 24 * 60 * 60 },
    });
    // Clamped to the 14-day max, not the requested ~999 days.
    expect(mint.json().expiresAt).toBeLessThan(Date.now() + 15 * 24 * 60 * 60_000);
  });
});
