import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { makeApp, seedAuthedUser, type TestApp } from '../../test/helpers/server.js';

let ctx: TestApp;
afterEach(async () => ctx && ctx.cleanup());

/** Enroll a device for an authed user and mint a bearer token. */
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
  return token.json().token as string;
}

const CALL_ID = 'call-abcdefgh12345';
const join = (callId: string, bearer?: string) =>
  ctx.app.inject({
    method: 'POST',
    url: `/api/relay/voice/rooms/${callId}/join`,
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });

describe('v8 voice SFU — capability-authed join', () => {
  it('joins a call room and returns real mediasoup router RTP capabilities', async () => {
    ctx = await makeApp();
    const alice = seedAuthedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice.cookie);

    const res = await join(CALL_ID, bearer);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { callId: string; routerRtpCapabilities: { codecs: { mimeType: string }[] }; peers: unknown[] };
    expect(body.callId).toBe(CALL_ID);
    // Real worker/router ran — opus is in the capabilities.
    expect(body.routerRtpCapabilities.codecs.some((c) => c.mimeType === 'audio/opus')).toBe(true);
    expect(body.peers).toEqual([]); // first in the room
  }, 20_000);

  it('rejects a join without a device token (401) and a malformed call id (400)', async () => {
    ctx = await makeApp();
    const alice = seedAuthedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice.cookie);

    expect((await join(CALL_ID)).statusCode).toBe(401);
    expect((await join('short', bearer)).statusCode).toBe(400);
  }, 20_000);

  it('shows the peer roster to the second joiner (no identities leaked)', async () => {
    ctx = await makeApp();
    const alice = seedAuthedUser(ctx.db, { handle: 'Alice#0001' });
    const bob = seedAuthedUser(ctx.db, { handle: 'Bob#0002' });
    const aBearer = await deviceBearer(alice.cookie);
    const bBearer = await deviceBearer(bob.cookie);

    await join(CALL_ID, aBearer); // Alice first
    const second = await join(CALL_ID, bBearer);
    const body = second.json() as { peers: { participantId: string; producerId: string | null }[] };
    expect(body.peers).toHaveLength(1);
    // Ephemeral participant id, no producer yet (nobody has produced).
    expect(body.peers[0]!.producerId).toBeNull();
    expect(typeof body.peers[0]!.participantId).toBe('string');
    expect(body.peers[0]!.participantId.length).toBeGreaterThan(0);
  }, 20_000);

  it('caps the room and rejects the overflow joiner (409)', async () => {
    ctx = await makeApp();
    const bearers: string[] = [];
    for (let i = 0; i < 8; i++) {
      const u = seedAuthedUser(ctx.db, { handle: `User#${1000 + i}` });
      bearers.push(await deviceBearer(u.cookie));
    }
    for (const b of bearers) expect((await join(CALL_ID, b)).statusCode).toBe(200);

    const overflow = seedAuthedUser(ctx.db, { handle: 'Over#9999' });
    const res = await join(CALL_ID, await deviceBearer(overflow.cookie));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('call full');

    // An already-joined device re-joining is idempotent (not a 409).
    expect((await join(CALL_ID, bearers[0]!)).statusCode).toBe(200);
  }, 30_000);
});
