import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto';
import { makeApp, seedAuthedUser, type TestApp } from '../../test/helpers/server.js';
import {
  detectRewrite,
  detectStall,
  verifyRootChain,
  verifyRootSignature,
  type SignedRoot,
} from '../src/ktAudit.js';

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
  const token = await ctx.app.inject({ method: 'POST', url: '/api/relay/auth/token', payload: { pubKey, nonce, signature } });
  return `Bearer ${token.json().token as string}`;
}

/** Register a fresh handle with random directory keys, minting epochs. */
async function publish(handle: string): Promise<void> {
  const u = seedAuthedUser(ctx.db, { handle });
  const bearer = await deviceBearer(u.cookie);
  await ctx.app.inject({
    method: 'PUT',
    url: '/api/relay/directory',
    headers: { authorization: bearer },
    payload: { identityPubKey: randomBytes(32).toString('base64'), sealingPubKey: randomBytes(32).toString('base64') },
  });
}

async function fetchAudit(): Promise<{ identityPubKey: string; roots: SignedRoot[] }> {
  const info = (await ctx.app.inject({ method: 'GET', url: '/api/relay/info' })).json();
  const roots = (await ctx.app.inject({ method: 'GET', url: '/api/relay/kt/roots' })).json().roots as SignedRoot[];
  return { identityPubKey: info.identityPubKey as string, roots };
}

describe('KT reference auditor', () => {
  it('verifies a genuine multi-epoch chain from the live relay', async () => {
    ctx = await makeApp();
    await publish('Alice#0001');
    await publish('Bravo#0002');
    await publish('Carol#0003');
    const { identityPubKey, roots } = await fetchAudit();
    expect(roots.length).toBe(3);
    const res = verifyRootChain(identityPubKey, roots);
    expect(res.ok).toBe(true);
    expect(res.verifiedEpochs).toBe(3);
    for (const r of roots) expect(verifyRootSignature(identityPubKey, r)).toBe(true);
  });

  it('rejects a forged signature', async () => {
    ctx = await makeApp();
    await publish('Alice#0001');
    const { identityPubKey, roots } = await fetchAudit();
    const tampered = { ...roots[0]!, signature: randomBytes(64).toString('base64') };
    expect(verifyRootSignature(identityPubKey, tampered)).toBe(false);
    expect(verifyRootChain(identityPubKey, [tampered]).ok).toBe(false);
  });

  it('rejects a broken chain link (rootHash swapped mid-chain)', async () => {
    ctx = await makeApp();
    await publish('Alice#0001');
    await publish('Bravo#0002');
    const { identityPubKey, roots } = await fetchAudit();
    // Corrupt the first root's hash — the second no longer chains onto it.
    const broken = [{ ...roots[0]!, rootHash: 'AAAurl_not_the_real_hash' }, roots[1]!];
    const res = verifyRootChain(identityPubKey, broken);
    expect(res.ok).toBe(false);
    // First root's signature no longer matches its mutated hash → fails there.
    expect(res.error).toMatch(/signature|chain/);
  });

  it('rejects a chain that does not start at the expected checkpoint', async () => {
    ctx = await makeApp();
    await publish('Alice#0001');
    const { identityPubKey, roots } = await fetchAudit();
    // Genesis chain must start from null; demanding a checkpoint it lacks fails.
    expect(verifyRootChain(identityPubKey, roots, 'some-checkpoint-hash').ok).toBe(false);
    expect(verifyRootChain(identityPubKey, roots, null).ok).toBe(true);
  });

  it('detects a rewritten epoch in watch mode', async () => {
    const seen = new Map<number, string>([
      [1, 'hashA'],
      [2, 'hashB'],
    ]);
    const honest: SignedRoot[] = [
      { epoch: 1, rootHash: 'hashA', prevRootHash: null, signature: '' },
      { epoch: 2, rootHash: 'hashB', prevRootHash: 'hashA', signature: '' },
    ];
    expect(detectRewrite(seen, honest)).toBeNull();

    const rewritten: SignedRoot[] = [
      { epoch: 1, rootHash: 'hashA', prevRootHash: null, signature: '' },
      { epoch: 2, rootHash: 'DIFFERENT', prevRootHash: 'hashA', signature: '' },
    ];
    expect(detectRewrite(seen, rewritten)).toEqual({ epoch: 2, was: 'hashB', now: 'DIFFERENT' });
  });

  it('detects a stalled log past the heartbeat gap', () => {
    const now = 1_000_000_000_000;
    const day = 24 * 60 * 60_000;
    expect(detectStall(now - day / 2, now, day)).toBe(false);
    expect(detectStall(now - day * 2, now, day)).toBe(true);
    expect(detectStall(undefined, now, day)).toBe(false); // empty log
  });
});
