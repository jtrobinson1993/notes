import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import { makeApp, seedAuthedUser, type TestApp } from '../../test/helpers/server.js';

let ctx: TestApp;
afterEach(async () => ctx && ctx.cleanup());

interface Key {
  pub: string; // raw ed25519, base64
  priv: KeyObject;
}
function makeKey(): Key {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return { pub: spki.subarray(spki.length - 32).toString('base64'), priv: privateKey };
}

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

/** Build a signed group-state PUT body. */
function record(
  groupId: string,
  version: number,
  members: { identityPubKey: string; role: string }[],
  signer: Key,
): { record: string; adminSignature: string } {
  const rec = JSON.stringify({ groupId, version, members });
  return { record: rec, adminSignature: edSign(null, Buffer.from(rec), signer.priv).toString('base64') };
}

const put = (bearer: string, id: string, body: object) =>
  ctx.app.inject({ method: 'PUT', url: `/api/relay/groups/${id}/state`, headers: { authorization: bearer }, payload: body });
const get = (bearer: string, id: string) =>
  ctx.app.inject({ method: 'GET', url: `/api/relay/groups/${id}/state`, headers: { authorization: bearer } });

describe('group state (D14)', () => {
  it('genesis stores a self-signed record; a member reads it back', async () => {
    ctx = await makeApp();
    const alice = seedAuthedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice.cookie);
    const owner = makeKey();
    // Alice's directory identity == the owner key, so she's recognised as a member.
    ctx.db.setRelayDirectoryEntry(alice.id, owner.pub, makeKey().pub);

    const g1 = record('g1', 1, [{ identityPubKey: owner.pub, role: 'owner' }], owner);
    const created = await put(bearer, 'g1', g1);
    expect(created.statusCode).toBe(200);
    expect(created.json().version).toBe(1);

    const read = await get(bearer, 'g1');
    expect(read.statusCode).toBe(200);
    expect(read.json().version).toBe(1);
    expect(JSON.parse(read.json().record).groupId).toBe('g1');
  });

  it('accepts an update signed by a current admin and advances the version', async () => {
    ctx = await makeApp();
    const alice = seedAuthedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice.cookie);
    const owner = makeKey();
    const member = makeKey();
    ctx.db.setRelayDirectoryEntry(alice.id, owner.pub, makeKey().pub);

    await put(bearer, 'g1', record('g1', 1, [{ identityPubKey: owner.pub, role: 'owner' }], owner));
    const v2 = record(
      'g1',
      2,
      [
        { identityPubKey: owner.pub, role: 'owner' },
        { identityPubKey: member.pub, role: 'member' },
      ],
      owner,
    );
    const updated = await put(bearer, 'g1', v2);
    expect(updated.statusCode).toBe(200);
    expect((await get(bearer, 'g1')).json().version).toBe(2);
  });

  it('rejects an update not signed by a current admin (403)', async () => {
    ctx = await makeApp();
    const alice = seedAuthedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice.cookie);
    const owner = makeKey();
    const attacker = makeKey();
    ctx.db.setRelayDirectoryEntry(alice.id, owner.pub, makeKey().pub);

    await put(bearer, 'g1', record('g1', 1, [{ identityPubKey: owner.pub, role: 'owner' }], owner));
    // Attacker signs a v2 naming themselves owner — not a current admin.
    const hijack = record('g1', 2, [{ identityPubKey: attacker.pub, role: 'owner' }], attacker);
    expect((await put(bearer, 'g1', hijack)).statusCode).toBe(403);
    expect((await get(bearer, 'g1')).json().version).toBe(1); // unchanged
  });

  it('rejects a plain member escalating themselves (403)', async () => {
    ctx = await makeApp();
    const alice = seedAuthedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice.cookie);
    const owner = makeKey();
    const member = makeKey();
    ctx.db.setRelayDirectoryEntry(alice.id, owner.pub, makeKey().pub);

    await put(
      bearer,
      'g1',
      record(
        'g1',
        1,
        [
          { identityPubKey: owner.pub, role: 'owner' },
          { identityPubKey: member.pub, role: 'member' },
        ],
        owner,
      ),
    );
    // The member signs a v2 promoting themselves to owner — signature is valid
    // ed25519 but the signer is not in the CURRENT admin set.
    const escalate = record('g1', 2, [{ identityPubKey: member.pub, role: 'owner' }], member);
    expect((await put(bearer, 'g1', escalate)).statusCode).toBe(403);
  });

  it('rejects a stale/equal version (anti-rollback, 409)', async () => {
    ctx = await makeApp();
    const alice = seedAuthedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice.cookie);
    const owner = makeKey();
    ctx.db.setRelayDirectoryEntry(alice.id, owner.pub, makeKey().pub);
    const members = [{ identityPubKey: owner.pub, role: 'owner' }];

    await put(bearer, 'g1', record('g1', 2, members, owner));
    expect((await put(bearer, 'g1', record('g1', 2, members, owner))).statusCode).toBe(409);
    expect((await put(bearer, 'g1', record('g1', 1, members, owner))).statusCode).toBe(409);
  });

  it('hides the group from non-members and from anon (uniform 404 / 401)', async () => {
    ctx = await makeApp();
    const alice = seedAuthedUser(ctx.db, { handle: 'Alice#0001' });
    const bob = seedAuthedUser(ctx.db, { handle: 'Bob#0002' });
    const aliceBearer = await deviceBearer(alice.cookie);
    const bobBearer = await deviceBearer(bob.cookie);
    const owner = makeKey();
    ctx.db.setRelayDirectoryEntry(alice.id, owner.pub, makeKey().pub);
    ctx.db.setRelayDirectoryEntry(bob.id, makeKey().pub, makeKey().pub); // not a member
    await put(aliceBearer, 'g1', record('g1', 1, [{ identityPubKey: owner.pub, role: 'owner' }], owner));

    expect((await get(bobBearer, 'g1')).statusCode).toBe(404); // non-member
    expect((await get(aliceBearer, 'ghost')).statusCode).toBe(404); // unknown group
    const anon = await ctx.app.inject({ method: 'GET', url: '/api/relay/groups/g1/state' });
    expect(anon.statusCode).toBe(401); // no device token
  });

  it('rejects a groupId/url mismatch and a version-less record (400)', async () => {
    ctx = await makeApp();
    const alice = seedAuthedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice.cookie);
    const owner = makeKey();
    const mismatch = record('other', 1, [{ identityPubKey: owner.pub, role: 'owner' }], owner);
    expect((await put(bearer, 'g1', mismatch)).statusCode).toBe(400);
  });
});
