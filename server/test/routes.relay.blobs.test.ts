import { describe, it, expect, afterEach } from 'vitest';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { enrollDevice as enrollRelayDevice, makeRelayApp, seedUser, type TestApp } from '../../test/helpers/server.js';

let ctx: TestApp;
afterEach(async () => ctx && ctx.cleanup());

async function deviceBearer(userId: string): Promise<string> {
  const { bearer } = await enrollRelayDevice(ctx.app, ctx.db, { userId });
  return bearer;
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
    ctx = await makeRelayApp();
    const alice = seedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice);
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
    ctx = await makeRelayApp();
    const alice = seedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice);
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
    ctx = await makeRelayApp();
    const alice = seedUser(ctx.db, { handle: 'Alice#0001' });
    const bob = seedUser(ctx.db, { handle: 'Bob#0002' });
    const aliceBearer = await deviceBearer(alice);
    const bobBearer = await deviceBearer(bob);
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
    ctx = await makeRelayApp();
    const alice = seedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice);
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
    ctx = await makeRelayApp();
    const alice = seedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice);
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

  it('serves a byte range (resumable download) with 206 + content-range', async () => {
    ctx = await makeRelayApp();
    const alice = seedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice);
    await setVerifier(bearer);

    const ciphertext = Buffer.from('0123456789abcdef'); // 16 bytes
    const up = await upload(
      { 'x-delivery-token': DELIVERY, 'x-recipient-handle': 'Alice#0001' },
      ciphertext,
    );
    const blobId = up.json().blobId as string;

    // Resume from byte 10 to the end.
    const tail = await ctx.app.inject({
      method: 'GET',
      url: `/api/relay/blobs/${blobId}`,
      headers: { authorization: bearer, range: 'bytes=10-' },
    });
    expect(tail.statusCode).toBe(206);
    expect(tail.headers['content-range']).toBe('bytes 10-15/16');
    expect(tail.headers['content-length']).toBe('6');
    expect(tail.headers['accept-ranges']).toBe('bytes');
    expect(tail.rawPayload.equals(ciphertext.subarray(10))).toBe(true);

    // Explicit closed range.
    const mid = await ctx.app.inject({
      method: 'GET',
      url: `/api/relay/blobs/${blobId}`,
      headers: { authorization: bearer, range: 'bytes=4-7' },
    });
    expect(mid.statusCode).toBe(206);
    expect(mid.headers['content-range']).toBe('bytes 4-7/16');
    expect(mid.rawPayload.equals(ciphertext.subarray(4, 8))).toBe(true);

    // Suffix range: last 3 bytes.
    const suf = await ctx.app.inject({
      method: 'GET',
      url: `/api/relay/blobs/${blobId}`,
      headers: { authorization: bearer, range: 'bytes=-3' },
    });
    expect(suf.statusCode).toBe(206);
    expect(suf.headers['content-range']).toBe('bytes 13-15/16');
    expect(suf.rawPayload.equals(ciphertext.subarray(13))).toBe(true);
  });

  it('advertises accept-ranges on a whole-blob GET and 416s an unsatisfiable range', async () => {
    ctx = await makeRelayApp();
    const alice = seedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice);
    await setVerifier(bearer);
    const ciphertext = Buffer.from('short');
    const up = await upload(
      { 'x-delivery-token': DELIVERY, 'x-recipient-handle': 'Alice#0001' },
      ciphertext,
    );
    const blobId = up.json().blobId as string;

    const whole = await ctx.app.inject({
      method: 'GET',
      url: `/api/relay/blobs/${blobId}`,
      headers: { authorization: bearer },
    });
    expect(whole.statusCode).toBe(200);
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.rawPayload.equals(ciphertext)).toBe(true);

    const past = await ctx.app.inject({
      method: 'GET',
      url: `/api/relay/blobs/${blobId}`,
      headers: { authorization: bearer, range: 'bytes=99-200' },
    });
    expect(past.statusCode).toBe(416);
    expect(past.headers['content-range']).toBe(`bytes */${ciphertext.length}`);

    const garbage = await ctx.app.inject({
      method: 'GET',
      url: `/api/relay/blobs/${blobId}`,
      headers: { authorization: bearer, range: 'rows=1-2' },
    });
    expect(garbage.statusCode).toBe(416);
  });

  it('ack deletes the blob (recipient only)', async () => {
    ctx = await makeRelayApp();
    const alice = seedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice);
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
