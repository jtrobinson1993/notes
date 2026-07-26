import { describe, it, expect, afterEach } from 'vitest';
import { createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, verify as edVerify } from 'node:crypto';
import { enrollDevice as enrollRelayDevice, makeRelayApp, seedUser, type TestApp } from '../../test/helpers/server.js';
import { leafHash, verifyInclusion, type ProofStep } from '../src/ktMerkle.js';

let ctx: TestApp;
afterEach(async () => ctx && ctx.cleanup());

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function deviceKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return { pubKey: spki.subarray(spki.length - 32).toString('base64'), privateKey };
}

async function deviceBearer(userId: string): Promise<string> {
  const { bearer } = await enrollRelayDevice(ctx.app, ctx.db, { userId });
  return bearer;
}

const identityKeys = () => ({
  identityPubKey: randomBytes(32).toString('base64'),
  sealingPubKey: randomBytes(32).toString('base64'),
});

describe('directory + KT roots (D5)', () => {
  it('registers keys, serves lookups, and publishes signed chained roots', async () => {
    ctx = await makeRelayApp();
    const alice = seedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice);
    const keys = identityKeys();

    const put = await ctx.app.inject({
      method: 'PUT',
      url: '/api/relay/directory',
      headers: { authorization: bearer },
      payload: keys,
    });
    expect(put.statusCode).toBe(200);
    const epoch1 = put.json().epoch as number;

    const lookup = await ctx.app.inject({ method: 'GET', url: '/api/relay/directory/Alice%230001' });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toMatchObject({ ...keys, epoch: epoch1 });

    // Re-publishing the same keys does not mint a new epoch.
    const rePut = await ctx.app.inject({
      method: 'PUT',
      url: '/api/relay/directory',
      headers: { authorization: bearer },
      payload: keys,
    });
    expect(rePut.json().epoch).toBe(epoch1);

    // A key change chains a new epoch onto the previous root.
    const rotated = identityKeys();
    const put2 = await ctx.app.inject({
      method: 'PUT',
      url: '/api/relay/directory',
      headers: { authorization: bearer },
      payload: rotated,
    });
    const epoch2 = put2.json().epoch as number;
    expect(epoch2).toBeGreaterThan(epoch1);

    const roots = await ctx.app.inject({ method: 'GET', url: '/api/relay/kt/roots' });
    const list = roots.json().roots as {
      epoch: number;
      rootHash: string;
      prevRootHash: string | null;
      signature: string;
    }[];
    expect(list).toHaveLength(2);
    expect(list[0].prevRootHash).toBeNull();
    expect(list[1].prevRootHash).toBe(list[0].rootHash);

    // Signatures verify against the relay identity key from /info.
    const info = await ctx.app.inject({ method: 'GET', url: '/api/relay/info' });
    const relayPub = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(info.json().identityPubKey as string, 'base64')]),
      format: 'der',
      type: 'spki',
    });
    for (const r of list) {
      const payload = `kt-root|${r.rootHash}|${r.prevRootHash ?? 'genesis'}`;
      expect(edVerify(null, Buffer.from(payload), relayPub, Buffer.from(r.signature, 'base64'))).toBe(true);
    }

    // since-filter + the well-known auditor alias.
    const since = await ctx.app.inject({ method: 'GET', url: `/api/relay/kt/roots?since=${epoch1}` });
    expect(since.json().roots).toHaveLength(1);
    const wellKnown = await ctx.app.inject({ method: 'GET', url: '/.well-known/accord/kt-roots' });
    expect(wellKnown.json()).toEqual(roots.json());
  });

  it('returns a per-entry inclusion proof that verifies against the signed root', async () => {
    ctx = await makeRelayApp();
    // Several registered handles ⇒ a real Merkle path (not just a lone leaf).
    const handles = ['Alice#0001', 'Bravo#0002', 'Carol#0003', 'Delta#0004', 'Echo#0005'];
    const registered: Record<string, { identityPubKey: string; sealingPubKey: string }> = {};
    for (const handle of handles) {
      const u = seedUser(ctx.db, { handle });
      const bearer = await deviceBearer(u);
      const keys = identityKeys();
      registered[handle] = keys;
      await ctx.app.inject({ method: 'PUT', url: '/api/relay/directory', headers: { authorization: bearer }, payload: keys });
    }

    const target = 'Carol#0003';
    const lookup = await ctx.app.inject({
      method: 'GET',
      url: `/api/relay/directory/${encodeURIComponent(target)}`,
    });
    expect(lookup.statusCode).toBe(200);
    const body = lookup.json() as {
      identityPubKey: string;
      sealingPubKey: string;
      rootHash: string;
      epoch: number;
      proof: ProofStep[];
    };

    // The returned key proves present under the epoch root.
    const leaf = leafHash({
      handle: target,
      identityPubkey: body.identityPubKey,
      sealingPubkey: body.sealingPubKey,
    });
    expect(verifyInclusion(leaf, body.proof, body.rootHash)).toBe(true);
    expect(body.proof.length).toBeGreaterThan(0);

    // The rootHash the proof lands on is exactly the latest signed KT root.
    const roots = (await ctx.app.inject({ method: 'GET', url: '/api/relay/kt/roots' })).json()
      .roots as { epoch: number; rootHash: string }[];
    const latest = roots[roots.length - 1];
    expect(body.rootHash).toBe(latest.rootHash);
    expect(body.epoch).toBe(latest.epoch);

    // A forged key at the same handle does NOT verify under the honest root.
    const forged = leafHash({ handle: target, identityPubkey: body.identityPubKey, sealingPubkey: randomBytes(32).toString('base64') });
    expect(verifyInclusion(forged, body.proof, body.rootHash)).toBe(false);
  });

  it('404s an unregistered handle and rejects malformed keys', async () => {
    ctx = await makeRelayApp();
    const alice = seedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice);

    const missing = await ctx.app.inject({ method: 'GET', url: '/api/relay/directory/Alice%230001' });
    expect(missing.statusCode).toBe(404);

    const bad = await ctx.app.inject({
      method: 'PUT',
      url: '/api/relay/directory',
      headers: { authorization: bearer },
      payload: { identityPubKey: 'short', sealingPubKey: 'short' },
    });
    expect(bad.statusCode).toBe(400);
  });
});
