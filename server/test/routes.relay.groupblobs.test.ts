import { describe, it, expect, afterEach } from 'vitest';
import { createHash, generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import { enrollDevice as enrollRelayDevice, makeRelayApp, seedUser, type TestApp } from '../../test/helpers/server.js';

let ctx: TestApp;
afterEach(async () => ctx && ctx.cleanup());

interface Key { pub: string; priv: KeyObject }
function makeKey(): Key {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return { pub: spki.subarray(spki.length - 32).toString('base64'), priv: privateKey };
}

async function deviceBearer(userId: string): Promise<string> {
  const { bearer } = await enrollRelayDevice(ctx.app, ctx.db, { userId });
  return bearer;
}

const GROUP_TOKEN = 'shared-group-token';
const groupVerifier = () => createHash('sha256').update(GROUP_TOKEN).digest('base64url');

const uploadGroup = (id: string, token: string, body: Buffer) =>
  ctx.app.inject({
    method: 'POST',
    url: `/api/relay/groups/${id}/blobs`,
    headers: { 'content-type': 'application/octet-stream', 'x-group-token': token },
    payload: body,
  });

/** Seed a group g1 owned by `owner`, with `alice` recognised as that owner via
 *  her directory entry, and the group blob verifier registered. */
async function seedGroup(aliceId: string, aliceBearer: string, owner: Key): Promise<void> {
  ctx.db.setRelayDirectoryEntry(aliceId, owner.pub, makeKey().pub);
  const rec = JSON.stringify({ groupId: 'g1', version: 1, members: [{ identityPubKey: owner.pub, role: 'owner' }] });
  await ctx.app.inject({
    method: 'PUT',
    url: '/api/relay/groups/g1/state',
    headers: { authorization: aliceBearer },
    payload: { record: rec, adminSignature: edSign(null, Buffer.from(rec), owner.priv).toString('base64') },
  });
  await ctx.app.inject({
    method: 'PUT',
    url: '/api/relay/groups/g1/verifier',
    headers: { authorization: aliceBearer },
    payload: { verifier: groupVerifier() },
  });
}

describe('group blobs (D6/D14)', () => {
  it('a member uploads with the group token and downloads by blobId', async () => {
    ctx = await makeRelayApp();
    const alice = seedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice);
    await seedGroup(alice, bearer, makeKey());

    const ciphertext = Buffer.from('sealed group attachment');
    const up = await uploadGroup('g1', GROUP_TOKEN, ciphertext);
    expect(up.statusCode).toBe(200);
    const blobId = up.json().blobId as string;

    const down = await ctx.app.inject({
      method: 'GET',
      url: `/api/relay/groups/g1/blobs/${blobId}`,
      headers: { authorization: bearer },
    });
    expect(down.statusCode).toBe(200);
    expect(down.rawPayload.equals(ciphertext)).toBe(true);
  });

  it('refuses upload with a wrong group token (uniform 401)', async () => {
    ctx = await makeRelayApp();
    const alice = seedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice);
    await seedGroup(alice, bearer, makeKey());
    expect((await uploadGroup('g1', 'wrong', Buffer.from('x'))).statusCode).toBe(401);
    // Unknown group (no verifier) is also 401 — no distinction.
    expect((await uploadGroup('ghost', GROUP_TOKEN, Buffer.from('x'))).statusCode).toBe(401);
  });

  it('a non-member cannot download (uniform 404)', async () => {
    ctx = await makeRelayApp();
    const alice = seedUser(ctx.db, { handle: 'Alice#0001' });
    const bob = seedUser(ctx.db, { handle: 'Bob#0002' });
    const aliceBearer = await deviceBearer(alice);
    const bobBearer = await deviceBearer(bob);
    await seedGroup(alice, aliceBearer, makeKey());
    ctx.db.setRelayDirectoryEntry(bob, makeKey().pub, makeKey().pub); // not in g1

    const blobId = (await uploadGroup('g1', GROUP_TOKEN, Buffer.from('secret'))).json().blobId as string;
    expect((await ctx.app.inject({
      method: 'GET',
      url: `/api/relay/groups/g1/blobs/${blobId}`,
      headers: { authorization: bobBearer },
    })).statusCode).toBe(404);
  });

  it('a non-member cannot set the group verifier (403)', async () => {
    ctx = await makeRelayApp();
    const alice = seedUser(ctx.db, { handle: 'Alice#0001' });
    const bob = seedUser(ctx.db, { handle: 'Bob#0002' });
    const aliceBearer = await deviceBearer(alice);
    const bobBearer = await deviceBearer(bob);
    await seedGroup(alice, aliceBearer, makeKey());
    ctx.db.setRelayDirectoryEntry(bob, makeKey().pub, makeKey().pub);

    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/relay/groups/g1/verifier',
      headers: { authorization: bobBearer },
      payload: { verifier: groupVerifier() },
    });
    expect(res.statusCode).toBe(403);
  });

  it('download requires a device token', async () => {
    ctx = await makeRelayApp();
    const alice = seedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice);
    await seedGroup(alice, bearer, makeKey());
    const blobId = (await uploadGroup('g1', GROUP_TOKEN, Buffer.from('x'))).json().blobId as string;
    const anon = await ctx.app.inject({ method: 'GET', url: `/api/relay/groups/g1/blobs/${blobId}` });
    expect(anon.statusCode).toBe(401);
  });
});
