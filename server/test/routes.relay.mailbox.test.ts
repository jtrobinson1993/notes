import { describe, it, expect, afterEach } from 'vitest';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { makeApp, seedAuthedUser, type TestApp } from '../../test/helpers/server.js';

let ctx: TestApp;
afterEach(async () => ctx && ctx.cleanup());

function deviceKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return { pubKey: spki.subarray(spki.length - 32).toString('base64'), privateKey };
}

/** Enroll a device for the cookie's user and get a bearer token for it. */
async function deviceWithToken(cookie: string) {
  const keys = deviceKeys();
  const enroll = await ctx.app.inject({
    method: 'POST',
    url: '/api/relay/devices',
    headers: { cookie },
    payload: { pubKey: keys.pubKey },
  });
  expect(enroll.statusCode).toBe(200);
  const info = await ctx.app.inject({ method: 'GET', url: '/api/relay/info' });
  const fp = info.json().identityFingerprint as string;
  const challenge = await ctx.app.inject({ method: 'POST', url: '/api/relay/auth/challenge' });
  const nonce = challenge.json().nonce as string;
  const signature = edSign(null, Buffer.from(`${nonce}|${fp}`), keys.privateKey).toString('base64');
  const token = await ctx.app.inject({
    method: 'POST',
    url: '/api/relay/auth/token',
    payload: { pubKey: keys.pubKey, nonce, signature },
  });
  expect(token.statusCode).toBe(200);
  return { bearer: `Bearer ${token.json().token as string}`, deviceId: enroll.json().deviceId as string };
}

const DELIVERY_TOKEN = 'the-secret-delivery-token';
const VERIFIER = createHash('sha256').update(DELIVERY_TOKEN).digest('base64url');
const ENVELOPE = Buffer.from('opaque ciphertext bytes').toString('base64');

async function send(handle: string, deliveryToken = DELIVERY_TOKEN) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/relay/mailbox/send',
    payload: { deliveryToken, recipientHandle: handle, envelope: ENVELOPE },
  });
}

describe('sealed-sender mailbox', () => {
  it('verifier registration requires a device token', async () => {
    ctx = await makeApp();
    const anon = await ctx.app.inject({
      method: 'PUT',
      url: '/api/relay/verifier',
      payload: { verifier: VERIFIER },
    });
    expect(anon.statusCode).toBe(401);
  });

  it('delivers to every active device; ack removes only own rows', async () => {
    ctx = await makeApp();
    const alice = seedAuthedUser(ctx.db, { handle: 'Alice#0001' });
    const d1 = await deviceWithToken(alice.cookie);
    const d2 = await deviceWithToken(alice.cookie);

    const reg = await ctx.app.inject({
      method: 'PUT',
      url: '/api/relay/verifier',
      headers: { authorization: d1.bearer },
      payload: { verifier: VERIFIER },
    });
    expect(reg.statusCode).toBe(200);

    // Sealed send: no auth header, only the delivery token.
    const sent = await send('Alice#0001');
    expect(sent.statusCode).toBe(200);
    expect(typeof sent.json().relayTs).toBe('number');

    // Both devices hold a copy.
    const fetch1 = await ctx.app.inject({
      method: 'GET',
      url: '/api/relay/mailbox',
      headers: { authorization: d1.bearer },
    });
    const fetch2 = await ctx.app.inject({
      method: 'GET',
      url: '/api/relay/mailbox',
      headers: { authorization: d2.bearer },
    });
    expect(fetch1.json()).toHaveLength(1);
    expect(fetch2.json()).toHaveLength(1);
    expect(fetch1.json()[0].envelope).toBe(ENVELOPE);

    // d1 acks its copy; d2's remains (hold-until-ack is per device).
    const ack = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/mailbox/ack',
      headers: { authorization: d1.bearer },
      payload: { queueIds: [fetch1.json()[0].queueId] },
    });
    expect(ack.json().acked).toBe(1);
    const after1 = await ctx.app.inject({
      method: 'GET',
      url: '/api/relay/mailbox',
      headers: { authorization: d1.bearer },
    });
    const after2 = await ctx.app.inject({
      method: 'GET',
      url: '/api/relay/mailbox',
      headers: { authorization: d2.bearer },
    });
    expect(after1.json()).toHaveLength(0);
    expect(after2.json()).toHaveLength(1);

    // Acking someone else's queue id is a no-op.
    const cross = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/mailbox/ack',
      headers: { authorization: d1.bearer },
      payload: { queueIds: [after2.json()[0].queueId] },
    });
    expect(cross.json().acked).toBe(0);
  });

  it('refuses delivery uniformly for bad token and unknown handle', async () => {
    ctx = await makeApp();
    const alice = seedAuthedUser(ctx.db, { handle: 'Alice#0001' });
    const d1 = await deviceWithToken(alice.cookie);
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/relay/verifier',
      headers: { authorization: d1.bearer },
      payload: { verifier: VERIFIER },
    });

    const badToken = await send('Alice#0001', 'wrong-token');
    const noSuchUser = await send('Nobody#9999');
    expect(badToken.statusCode).toBe(401);
    expect(noSuchUser.statusCode).toBe(401);
    expect(badToken.json()).toEqual(noSuchUser.json()); // no enumeration signal
  });

  it('relay timestamps are strictly increasing across sends', async () => {
    ctx = await makeApp();
    const alice = seedAuthedUser(ctx.db, { handle: 'Alice#0001' });
    const d1 = await deviceWithToken(alice.cookie);
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/relay/verifier',
      headers: { authorization: d1.bearer },
      payload: { verifier: VERIFIER },
    });
    const a = await send('Alice#0001');
    const b = await send('Alice#0001');
    expect(b.json().relayTs).toBeGreaterThan(a.json().relayTs);
  });

  it('rejects oversized envelopes', async () => {
    ctx = await makeApp();
    seedAuthedUser(ctx.db, { handle: 'Alice#0001' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/mailbox/send',
      payload: {
        deliveryToken: DELIVERY_TOKEN,
        recipientHandle: 'Alice#0001',
        envelope: 'A'.repeat(300 * 1024),
      },
    });
    expect(res.statusCode).toBe(413);
  });
});
