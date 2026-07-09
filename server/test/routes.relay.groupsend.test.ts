import { describe, it, expect, afterEach } from 'vitest';
import { createHash, generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import { makeApp, seedAuthedUser, type TestApp } from '../../test/helpers/server.js';

let t: TestApp;
afterEach(async () => t && t.cleanup());

interface Key { pub: string; priv: KeyObject }
function makeKey(): Key {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return { pub: spki.subarray(spki.length - 32).toString('base64'), priv: privateKey };
}

/** Enroll a device for an authed user; return its bearer (for mailbox reads). */
async function deviceBearer(cookie: string): Promise<string> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const pubKey = spki.subarray(spki.length - 32).toString('base64');
  await t.app.inject({ method: 'POST', url: '/api/relay/devices', headers: { cookie }, payload: { pubKey } });
  const info = await t.app.inject({ method: 'GET', url: '/api/relay/info' });
  const challenge = await t.app.inject({ method: 'POST', url: '/api/relay/auth/challenge' });
  const nonce = challenge.json().nonce as string;
  const signature = edSign(
    null,
    Buffer.from(`${nonce}|${info.json().identityFingerprint as string}`),
    privateKey,
  ).toString('base64');
  const token = await t.app.inject({
    method: 'POST',
    url: '/api/relay/auth/token',
    payload: { pubKey, nonce, signature },
  });
  return `Bearer ${token.json().token as string}`;
}

const GROUP_TOKEN = 'shared-group-token';
const groupVerifier = () => createHash('sha256').update(GROUP_TOKEN).digest('base64url');

describe('group send fan-out (D6/D14)', () => {
  it('fans one group-token-authed envelope to every member device', async () => {
    t = await makeApp();
    const alice = seedAuthedUser(t.db, { handle: 'Alice#0001' });
    const bob = seedAuthedUser(t.db, { handle: 'Bob#0002' });
    const aBearer = await deviceBearer(alice.cookie);
    const bBearer = await deviceBearer(bob.cookie);

    const kAlice = makeKey();
    const kBob = makeKey();
    // Directory entries map identity key → account → devices.
    t.db.setRelayDirectoryEntry(alice.id, kAlice.pub, makeKey().pub);
    t.db.setRelayDirectoryEntry(bob.id, kBob.pub, makeKey().pub);

    // Group state g1 with both members, signed by the owner (Alice).
    const rec = JSON.stringify({
      groupId: 'g1',
      version: 1,
      members: [
        { identityPubKey: kAlice.pub, role: 'owner' },
        { identityPubKey: kBob.pub, role: 'member' },
      ],
    });
    await t.app.inject({
      method: 'PUT',
      url: '/api/relay/groups/g1/state',
      headers: { authorization: aBearer },
      payload: { record: rec, adminSignature: edSign(null, Buffer.from(rec), kAlice.priv).toString('base64') },
    });
    await t.app.inject({
      method: 'PUT',
      url: '/api/relay/groups/g1/verifier',
      headers: { authorization: aBearer },
      payload: { verifier: groupVerifier() },
    });

    const envelope = Buffer.from('group-sealed').toString('base64');
    const send = await t.app.inject({
      method: 'POST',
      url: '/api/relay/groups/g1/send',
      payload: { groupToken: GROUP_TOKEN, envelope },
    });
    expect(send.statusCode).toBe(200);
    expect(send.json().relayTs).toBeGreaterThan(0);

    // Both members' device queues received the envelope.
    for (const bearer of [aBearer, bBearer]) {
      const box = await t.app.inject({ method: 'GET', url: '/api/relay/mailbox', headers: { authorization: bearer } });
      expect(box.json()).toHaveLength(1);
      expect(box.json()[0].envelope).toBe(envelope);
    }
  });

  it('refuses a wrong/unknown group token (401)', async () => {
    t = await makeApp();
    const alice = seedAuthedUser(t.db, { handle: 'Alice#0001' });
    const aBearer = await deviceBearer(alice.cookie);
    const kAlice = makeKey();
    t.db.setRelayDirectoryEntry(alice.id, kAlice.pub, makeKey().pub);
    const rec = JSON.stringify({ groupId: 'g1', version: 1, members: [{ identityPubKey: kAlice.pub, role: 'owner' }] });
    await t.app.inject({
      method: 'PUT',
      url: '/api/relay/groups/g1/state',
      headers: { authorization: aBearer },
      payload: { record: rec, adminSignature: edSign(null, Buffer.from(rec), kAlice.priv).toString('base64') },
    });
    await t.app.inject({
      method: 'PUT',
      url: '/api/relay/groups/g1/verifier',
      headers: { authorization: aBearer },
      payload: { verifier: groupVerifier() },
    });
    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/relay/groups/g1/send',
      payload: { groupToken: 'wrong', envelope: Buffer.from('x').toString('base64') },
    });
    expect(bad.statusCode).toBe(401);
  });
});
