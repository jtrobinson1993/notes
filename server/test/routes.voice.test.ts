import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authCookie, makeApp, makeFriends, seedUser, type TestApp } from '../../test/helpers/server.js';
import type { ChannelInfo, Conversation, VoiceJoinResponse, VoiceTransportResponse } from '@notes/shared';

const SEALED = { epk: 'AAAA', iv: 'BBBB', ct: 'CCCC' };

let t: TestApp;
let owner: string;
let a: string;
let b: string;
let outsider: string;
let ownerCookie: string;
let aCookie: string;
let outsiderCookie: string;
let convId: string;
let voiceId: string;
let textId: string;

function inject(method: string, url: string, cookie?: string, payload?: unknown) {
  return t.app.inject({ method: method as 'GET', url, headers: cookie ? { cookie } : {}, payload: payload as object });
}
const convOf = async (userId: string): Promise<Conversation> =>
  ((await inject('GET', '/api/conversations', authCookie(t.db, userId))).json() as Conversation[]).find((c) => c.id === convId)!;
const channels = async (): Promise<ChannelInfo[]> => (await convOf(owner)).channels;

beforeEach(async () => {
  t = await makeApp();
  owner = seedUser(t.db, { publicKey: 'pk-o' });
  a = seedUser(t.db, { publicKey: 'pk-a' });
  b = seedUser(t.db, { publicKey: 'pk-b' });
  outsider = seedUser(t.db, { publicKey: 'pk-x' });
  makeFriends(t.db, owner, a);
  makeFriends(t.db, owner, b);
  ownerCookie = authCookie(t.db, owner);
  aCookie = authCookie(t.db, a);
  outsiderCookie = authCookie(t.db, outsider);
  convId = (await inject('POST', '/api/conversations/group', ownerCookie, { members: [owner, a, b].map((userId) => ({ userId, sealedKey: SEALED })) })).json().id;
  await inject('POST', `/api/conversations/${convId}/channels`, ownerCookie, { name: 'Voice', type: 'voice' });
  await inject('POST', `/api/conversations/${convId}/channels`, ownerCookie, { name: 'Text', type: 'text' });
  const chs = await channels();
  voiceId = chs.find((c) => c.type === 'voice')!.id;
  textId = chs.find((c) => c.type === 'text' && !c.isDefault)!.id;
});
afterEach(() => t.cleanup());

const join = (roomId: string, cookie: string) => inject('POST', `/api/voice/rooms/${roomId}/join`, cookie);

describe('voice routes — access control', () => {
  it('rejects joining a non-voice (text) channel', async () => {
    expect((await join(textId, ownerCookie)).statusCode).toBe(403);
  });
  it('rejects joining as a non-member of the conversation', async () => {
    expect((await join(voiceId, outsiderCookie)).statusCode).toBe(403);
  });
  it('rejects an unknown room id', async () => {
    expect((await join('nonexistent', ownerCookie)).statusCode).toBe(403);
  });
  it('requires authentication', async () => {
    expect((await join(voiceId, undefined)).statusCode).toBe(401);
  });
});

describe('voice routes — join + mediasoup', () => {
  it('joins, returning real mediasoup router RTP capabilities and my (empty) roster/keys', async () => {
    const res = await join(voiceId, ownerCookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as VoiceJoinResponse;
    expect(body.roomId).toBe(voiceId);
    // Real mediasoup router capabilities — proves the worker/router actually ran.
    const caps = body.routerRtpCapabilities as { codecs?: { mimeType: string }[] };
    expect(caps.codecs?.some((c) => c.mimeType === 'audio/opus')).toBe(true);
    expect(body.peers).toEqual([]);
    expect(body.epoch).toBe(-1);
    expect(body.mediaKeys).toEqual([]);
  });

  it('creates a real WebRtcTransport with ICE/DTLS parameters', async () => {
    await join(voiceId, ownerCookie);
    const res = await inject('POST', `/api/voice/rooms/${voiceId}/transport`, ownerCookie, { direction: 'send' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as VoiceTransportResponse;
    expect(typeof body.id).toBe('string');
    expect(body.iceParameters).toBeTruthy();
    expect(Array.isArray(body.iceCandidates)).toBe(true);
    expect(body.dtlsParameters).toBeTruthy();
  });

  it('rejects a transport request before joining', async () => {
    const res = await inject('POST', `/api/voice/rooms/${voiceId}/transport`, ownerCookie, { direction: 'send' });
    expect(res.statusCode).toBe(409);
  });
});

describe('voice routes — rekey', () => {
  const rekey = (cookie: string, epoch: number, userIds: string[]) =>
    inject('POST', `/api/voice/rooms/${voiceId}/rekey`, cookie, { epoch, keys: userIds.map((userId) => ({ userId, sealedKey: SEALED })) });

  it('lets the owner commit epoch 0, then reflects it for the next joiner', async () => {
    await join(voiceId, ownerCookie);
    expect((await rekey(ownerCookie, 0, [owner])).statusCode).toBe(200);
    // a joins -> their join response sees the committed epoch 0.
    const aBody = (await join(voiceId, aCookie)).json() as VoiceJoinResponse;
    expect(aBody.epoch).toBe(0);
    expect(aBody.peers.map((p) => p.userId)).toEqual([owner]);
    // owner re-keys to epoch 1 over both members.
    expect((await rekey(ownerCookie, 1, [owner, a])).statusCode).toBe(200);
  });

  it('rejects a rekey from a non-owner', async () => {
    await join(voiceId, ownerCookie);
    await rekey(ownerCookie, 0, [owner]);
    await join(voiceId, aCookie);
    // a is not the owner (owner joined first) -> 409.
    expect((await rekey(aCookie, 1, [owner, a])).statusCode).toBe(409);
  });

  it('rejects a rekey that does not cover the exact roster', async () => {
    await join(voiceId, ownerCookie);
    await join(voiceId, aCookie);
    expect((await rekey(ownerCookie, 0, [owner])).statusCode).toBe(409); // missing a
  });
});

describe('voice routes — leave', () => {
  it('leaving is idempotent and lets you rejoin', async () => {
    await join(voiceId, ownerCookie);
    expect((await inject('POST', `/api/voice/rooms/${voiceId}/leave`, ownerCookie)).statusCode).toBe(200);
    expect((await inject('POST', `/api/voice/rooms/${voiceId}/leave`, ownerCookie)).statusCode).toBe(200);
    expect((await join(voiceId, ownerCookie)).statusCode).toBe(200);
  });
});
