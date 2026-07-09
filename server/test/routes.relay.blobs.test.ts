import { describe, it, expect, afterEach } from 'vitest';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
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

const DELIVERY = 'alice-delivery-token';

/** Register Alice's delivery-token verifier so uploads addressed to her pass. */
async function setVerifier(bearer: string): Promise<void> {
  const verifier = createHash('sha256').update(DELIVERY).digest('base64url');
  await ctx.app.inject({
    method: 'PUT',
    url: '/api/relay/verifier',
    headers: { authorization: bearer },
    payload: { verifier },
  });
}

const upload = (headers: Record<string, string>, body: Buffer) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/relay/blobs',
    headers: { 'content-type': 'application/octet-stream', ...headers },
    payload: body,
  });

describe('transient blob store (D6)', () => {
  it('uploads with a delivery token and the recipient downloads by blobId', async () => {
    ctx = await makeApp();
    const alice = seedAuthedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice.cookie);
    await setVerifier(bearer);

    const ciphertext = Buffer.from('sealed-attachment-bytes');
    const up = await upload(
      { 'x-delivery-token': DELIVERY, 'x-recipient-handle': 'Alice#0001' },
      ciphertext,
    );
    expect(up.statusCode).toBe(200);
    const blobId = up.json().blobId as string;
    expect(up.json().size).toBe(ciphertext.length);

    const down = await ctx.app.inject({
      method: 'GET',
      url: `/api/relay/blobs/${blobId}`,
      headers: { authorization: bearer },
    });
    expect(down.statusCode).toBe(200);
    expect(down.rawPayload.equals(ciphertext)).toBe(true);
  });

  it('refuses upload with a wrong delivery token (uniform 401)', async () => {
    ctx = await makeApp();
    const alice = seedAuthedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice.cookie);
    await setVerifier(bearer);

    const wrong = await upload(
      { 'x-delivery-token': 'nope', 'x-recipient-handle': 'Alice#0001' },
      Buffer.from('x'),
    );
    const unknownHandle = await upload(
      { 'x-delivery-token': DELIVERY, 'x-recipient-handle': 'Ghost#0000' },
      Buffer.from('x'),
    );
    expect(wrong.statusCode).toBe(401);
    expect(unknownHandle.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknownHandle.json());
  });

  it('a non-recipient device cannot download (uniform 404)', async () => {
    ctx = await makeApp();
    const alice = seedAuthedUser(ctx.db, { handle: 'Alice#0001' });
    const bob = seedAuthedUser(ctx.db, { handle: 'Bob#0002' });
    const aliceBearer = await deviceBearer(alice.cookie);
    const bobBearer = await deviceBearer(bob.cookie);
    await setVerifier(aliceBearer);

    const up = await upload(
      { 'x-delivery-token': DELIVERY, 'x-recipient-handle': 'Alice#0001' },
      Buffer.from('secret'),
    );
    const blobId = up.json().blobId as string;

    const asBob = await ctx.app.inject({
      method: 'GET',
      url: `/api/relay/blobs/${blobId}`,
      headers: { authorization: bobBearer },
    });
    const unknownId = await ctx.app.inject({
      method: 'GET',
      url: `/api/relay/blobs/${blobId}`,
      headers: { authorization: aliceBearer },
    });
    expect(asBob.statusCode).toBe(404);
    // sanity: the real recipient still gets it
    expect(unknownId.statusCode).toBe(200);
  });

  it('download requires a device token', async () => {
    ctx = await makeApp();
    const alice = seedAuthedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice.cookie);
    await setVerifier(bearer);
    const up = await upload(
      { 'x-delivery-token': DELIVERY, 'x-recipient-handle': 'Alice#0001' },
      Buffer.from('x'),
    );
    const anon = await ctx.app.inject({
      method: 'GET',
      url: `/api/relay/blobs/${up.json().blobId as string}`,
    });
    expect(anon.statusCode).toBe(401);
  });

  it('rejects a traversal id and unknown id uniformly', async () => {
    ctx = await makeApp();
    const alice = seedAuthedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice.cookie);
    const traversal = await ctx.app.inject({
      method: 'GET',
      url: '/api/relay/blobs/..%2f..%2fetc%2fpasswd',
      headers: { authorization: bearer },
    });
    const unknown = await ctx.app.inject({
      method: 'GET',
      url: '/api/relay/blobs/doesnotexist',
      headers: { authorization: bearer },
    });
    expect(traversal.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
  });

  it('ack deletes the blob (recipient only)', async () => {
    ctx = await makeApp();
    const alice = seedAuthedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice.cookie);
    await setVerifier(bearer);
    const up = await upload(
      { 'x-delivery-token': DELIVERY, 'x-recipient-handle': 'Alice#0001' },
      Buffer.from('gone-soon'),
    );
    const blobId = up.json().blobId as string;

    const ack = await ctx.app.inject({
      method: 'POST',
      url: `/api/relay/blobs/${blobId}/ack`,
      headers: { authorization: bearer },
    });
    expect(ack.statusCode).toBe(200);

    const after = await ctx.app.inject({
      method: 'GET',
      url: `/api/relay/blobs/${blobId}`,
      headers: { authorization: bearer },
    });
    expect(after.statusCode).toBe(404);
  });
});
