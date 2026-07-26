import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { enrollDevice as enrollRelayDevice, makeRelayApp, seedUser, type TestApp } from '../../test/helpers/server.js';

let ctx: TestApp;
afterEach(async () => ctx && ctx.cleanup());

/** Enroll a device for an authed user and mint a bearer token. */
async function deviceBearer(userId: string): Promise<string> {
  const { token } = await enrollRelayDevice(ctx.app, ctx.db, { userId });
  return token; // raw token; call sites add the `Bearer ` prefix
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
    ctx = await makeRelayApp();
    const alice = seedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice);

    const res = await join(CALL_ID, bearer);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { callId: string; routerRtpCapabilities: { codecs: { mimeType: string }[] }; peers: unknown[] };
    expect(body.callId).toBe(CALL_ID);
    // Real worker/router ran — opus is in the capabilities.
    expect(body.routerRtpCapabilities.codecs.some((c) => c.mimeType === 'audio/opus')).toBe(true);
    expect(body.peers).toEqual([]); // first in the room
  }, 20_000);

  it('rejects a join without a device token (401) and a malformed call id (400)', async () => {
    ctx = await makeRelayApp();
    const alice = seedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice);

    expect((await join(CALL_ID)).statusCode).toBe(401);
    expect((await join('short', bearer)).statusCode).toBe(400);
  }, 20_000);

  it('shows the peer roster to the second joiner (no identities leaked)', async () => {
    ctx = await makeRelayApp();
    const alice = seedUser(ctx.db, { handle: 'Alice#0001' });
    const bob = seedUser(ctx.db, { handle: 'Bob#0002' });
    const aBearer = await deviceBearer(alice);
    const bBearer = await deviceBearer(bob);

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
    ctx = await makeRelayApp();
    const bearers: string[] = [];
    for (let i = 0; i < 8; i++) {
      const u = seedUser(ctx.db, { handle: `User#${1000 + i}` });
      bearers.push(await deviceBearer(u));
    }
    for (const b of bearers) expect((await join(CALL_ID, b)).statusCode).toBe(200);

    const overflow = seedUser(ctx.db, { handle: 'Over#9999' });
    const res = await join(CALL_ID, await deviceBearer(overflow.cookie));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('call full');

    // An already-joined device re-joining is idempotent (not a 409).
    expect((await join(CALL_ID, bearers[0]!)).statusCode).toBe(200);
  }, 30_000);
});

const post = (path: string, bearer?: string, payload?: unknown) =>
  ctx.app.inject({
    method: 'POST',
    url: `/api/relay/voice/rooms/${CALL_ID}/${path}`,
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    payload: payload as object,
  });

describe('v8 voice SFU — media endpoints', () => {
  it('creates real send + recv WebRtcTransports for a member', async () => {
    ctx = await makeRelayApp();
    const alice = seedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice);
    await join(CALL_ID, bearer);

    for (const direction of ['send', 'recv'] as const) {
      const res = await post('transport', bearer, { direction });
      expect(res.statusCode).toBe(200);
      const t = res.json() as { id: string; iceParameters: unknown; iceCandidates: unknown[]; dtlsParameters: unknown };
      expect(typeof t.id).toBe('string');
      expect(t.iceParameters).toBeTruthy(); // real mediasoup transport params
      expect(Array.isArray(t.iceCandidates)).toBe(true);
      expect(t.dtlsParameters).toBeTruthy();
    }
  }, 20_000);

  it('rejects media calls from a non-member (401) and a bad direction (400)', async () => {
    ctx = await makeRelayApp();
    const alice = seedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice);

    // Not joined yet → not in call.
    expect((await post('transport', bearer, { direction: 'send' })).statusCode).toBe(401);
    expect((await post('transport')).statusCode).toBe(401); // anonymous
    await join(CALL_ID, bearer);
    expect((await post('transport', bearer, { direction: 'sideways' })).statusCode).toBe(400);
  }, 20_000);

  it('404s connect/produce/consume against an unknown transport', async () => {
    ctx = await makeRelayApp();
    const alice = seedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice);
    await join(CALL_ID, bearer);

    expect((await post('transport/connect', bearer, { transportId: 'nope', dtlsParameters: {} })).statusCode).toBe(404);
    expect((await post('produce', bearer, { transportId: 'nope', rtpParameters: {} })).statusCode).toBe(404);
    expect((await post('consume', bearer, { transportId: 'nope', producerId: 'x', rtpCapabilities: {} })).statusCode).toBe(404);
  }, 20_000);

  it('leave drops membership (subsequent media calls 401)', async () => {
    ctx = await makeRelayApp();
    const alice = seedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice);
    await join(CALL_ID, bearer);
    expect((await post('leave', bearer)).statusCode).toBe(200);
    expect((await post('transport', bearer, { direction: 'send' })).statusCode).toBe(401);
  }, 20_000);
});
