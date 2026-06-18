import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authCookie, makeApp, makeFriends, seedUser, type TestApp } from '../../test/helpers/server.js';
import type { ChannelInfo, Conversation } from '@notes/shared';

const SEALED = { epk: 'AAAA', iv: 'BBBB', ct: 'CCCC' };

let t: TestApp;
let owner: string;
let a: string;
let b: string;
let ownerCookie: string;
let aCookie: string;
let convId: string; // a group {owner, a, b}
let dmId: string; // owner<->a DM

function inject(method: string, url: string, cookie?: string, payload?: unknown) {
  return t.app.inject({ method: method as 'GET', url, headers: cookie ? { cookie } : {}, payload: payload as object });
}
const keysFor = (ids: string[]) => ids.map((userId) => ({ userId, sealedKey: SEALED }));
const getConv = async (userId: string, id: string): Promise<Conversation | undefined> =>
  ((await inject('GET', '/api/conversations', authCookie(t.db, userId))).json() as Conversation[]).find((c) => c.id === id);
const channelsOf = async (userId: string, id: string): Promise<ChannelInfo[]> =>
  (await getConv(userId, id))?.channels ?? [];

beforeEach(async () => {
  t = await makeApp();
  owner = seedUser(t.db, { publicKey: 'pk-o' });
  a = seedUser(t.db, { publicKey: 'pk-a' });
  b = seedUser(t.db, { publicKey: 'pk-b' });
  for (const u of [a, b]) makeFriends(t.db, owner, u);
  makeFriends(t.db, a, b);
  ownerCookie = authCookie(t.db, owner);
  aCookie = authCookie(t.db, a);
  convId = (await inject('POST', '/api/conversations/group', ownerCookie, { members: keysFor([owner, a, b]) })).json().id;
  dmId = (await inject('POST', '/api/conversations/dm', ownerCookie, { friendId: a, members: keysFor([owner, a]) })).json().id;
});
afterEach(() => t.cleanup());

const createChannel = (name: string, type = 'text', cookie = ownerCookie) =>
  inject('POST', `/api/conversations/${convId}/channels`, cookie, { name, type });

describe('channels — general (virtual)', () => {
  it('every conversation exposes a general channel whose id is the conversation id', async () => {
    const channels = await channelsOf(owner, convId);
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({ id: convId, isDefault: true, type: 'text', position: 0 });
    // DMs too — just the general channel.
    expect((await channelsOf(owner, dmId)).map((c) => c.isDefault)).toEqual([true]);
  });
});

describe('channels — create', () => {
  it('owner creates a text channel; it appears for every member', async () => {
    const res = await createChannel('random');
    expect(res.statusCode).toBe(200);
    const forA = await channelsOf(a, convId);
    expect(forA).toHaveLength(2);
    const created = forA.find((c) => !c.isDefault)!;
    expect(created).toMatchObject({ name: 'random', type: 'text', isDefault: false, position: 1, lastSeq: 0, lastReadSeq: 0 });
  });

  it('supports a voice channel type', async () => {
    await createChannel('Lounge', 'voice');
    const ch = (await channelsOf(owner, convId)).find((c) => !c.isDefault)!;
    expect(ch.type).toBe('voice');
  });

  it('rejects channels in a DM (groups only)', async () => {
    const res = await inject('POST', `/api/conversations/${dmId}/channels`, ownerCookie, { name: 'x', type: 'text' });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a plain member, allows an admin', async () => {
    expect((await createChannel('nope', 'text', aCookie)).statusCode).toBe(403);
    await inject('POST', `/api/conversations/${convId}/members/${a}/role`, ownerCookie, { role: 'admin' });
    expect((await createChannel('yep', 'text', aCookie)).statusCode).toBe(200);
  });

  it('rejects an empty / over-long name and an invalid type', async () => {
    expect((await createChannel('', 'text')).statusCode).toBe(400);
    expect((await createChannel('x'.repeat(51), 'text')).statusCode).toBe(400);
    expect((await inject('POST', `/api/conversations/${convId}/channels`, ownerCookie, { name: 'y', type: 'bogus' })).statusCode).toBe(400);
  });

  it('rejects a non-member outsider', async () => {
    const outsider = authCookie(t.db, seedUser(t.db));
    expect((await createChannel('x', 'text', outsider)).statusCode).toBe(403);
  });
});

describe('channels — rename / reorder / delete', () => {
  it('renames an extra channel but not the general one (general is not a row)', async () => {
    await createChannel('random');
    const ch = (await channelsOf(owner, convId)).find((c) => !c.isDefault)!;
    expect((await inject('PATCH', `/api/conversations/${convId}/channels/${ch.id}`, ownerCookie, { name: 'memes' })).statusCode).toBe(200);
    expect((await channelsOf(owner, convId)).find((c) => c.id === ch.id)!.name).toBe('memes');
    // general id == convId is not in the channels table → 404.
    expect((await inject('PATCH', `/api/conversations/${convId}/channels/${convId}`, ownerCookie, { name: 'x' })).statusCode).toBe(404);
  });

  it('reorders channels by a full permutation', async () => {
    await createChannel('one');
    await createChannel('two');
    const extra = (await channelsOf(owner, convId)).filter((c) => !c.isDefault);
    const reversed = [extra[1]!.id, extra[0]!.id];
    expect((await inject('POST', `/api/conversations/${convId}/channels/reorder`, ownerCookie, { order: reversed })).statusCode).toBe(200);
    const after = (await channelsOf(owner, convId)).filter((c) => !c.isDefault).map((c) => c.id);
    expect(after).toEqual(reversed);
  });

  it('rejects a reorder that is not a full permutation', async () => {
    await createChannel('one');
    await createChannel('two');
    const extra = (await channelsOf(owner, convId)).filter((c) => !c.isDefault);
    expect((await inject('POST', `/api/conversations/${convId}/channels/reorder`, ownerCookie, { order: [extra[0]!.id] })).statusCode).toBe(400);
    expect((await inject('POST', `/api/conversations/${convId}/channels/reorder`, ownerCookie, { order: [extra[0]!.id, extra[0]!.id] })).statusCode).toBe(400);
  });

  it('deletes a channel and its messages; cannot delete general', async () => {
    await createChannel('random');
    const ch = (await channelsOf(owner, convId)).find((c) => !c.isDefault)!;
    await inject('POST', `/api/conversations/${convId}/messages`, ownerCookie, { ciphertext: 'c', iv: 'i', epoch: 0, channelId: ch.id });
    expect((await inject('DELETE', `/api/conversations/${convId}/channels/${convId}`, ownerCookie)).statusCode).toBe(404);
    expect((await inject('DELETE', `/api/conversations/${convId}/channels/${ch.id}`, ownerCookie)).statusCode).toBe(200);
    expect((await channelsOf(owner, convId)).some((c) => c.id === ch.id)).toBe(false);
    expect((t.db.raw.prepare('SELECT COUNT(*) AS c FROM messages WHERE channel_id = ?').get(ch.id) as { c: number }).c).toBe(0);
  });
});

describe('channels — message isolation + per-channel seq/read', () => {
  it('routes messages to their channel; seq is shared+monotonic per conversation', async () => {
    await createChannel('random');
    const ch = (await channelsOf(owner, convId)).find((c) => !c.isDefault)!;
    // general seq 1, channel seq 2, general seq 3 — one monotonic conversation sequence.
    await inject('POST', `/api/conversations/${convId}/messages`, ownerCookie, { ciphertext: 'g1', iv: 'i', epoch: 0 });
    await inject('POST', `/api/conversations/${convId}/messages`, ownerCookie, { ciphertext: 'c1', iv: 'i', epoch: 0, channelId: ch.id });
    await inject('POST', `/api/conversations/${convId}/messages`, ownerCookie, { ciphertext: 'g2', iv: 'i', epoch: 0 });

    const general = (await inject('GET', `/api/conversations/${convId}/messages`, ownerCookie)).json();
    const inChannel = (await inject('GET', `/api/conversations/${convId}/messages?channelId=${ch.id}`, ownerCookie)).json();
    expect(general.map((m: { seq: number }) => m.seq)).toEqual([3, 1]);
    expect(inChannel.map((m: { seq: number; channelId: string }) => m.seq)).toEqual([2]);
    expect(inChannel[0].channelId).toBe(ch.id);

    const channels = await channelsOf(owner, convId);
    expect(channels.find((c) => c.isDefault)!.lastSeq).toBe(3);
    expect(channels.find((c) => c.id === ch.id)!.lastSeq).toBe(2);
  });

  it('tracks read cursors per channel independently', async () => {
    await createChannel('random');
    const ch = (await channelsOf(owner, convId)).find((c) => !c.isDefault)!;
    await inject('POST', `/api/conversations/${convId}/messages`, ownerCookie, { ciphertext: 'g', iv: 'i', epoch: 0 });
    await inject('POST', `/api/conversations/${convId}/messages`, ownerCookie, { ciphertext: 'c', iv: 'i', epoch: 0, channelId: ch.id });
    // owner reads only the channel.
    await inject('POST', `/api/conversations/${convId}/read`, ownerCookie, { seq: 2, channelId: ch.id });
    const channels = await channelsOf(owner, convId);
    expect(channels.find((c) => c.isDefault)!.lastReadSeq).toBe(0); // general untouched
    expect(channels.find((c) => c.id === ch.id)!.lastReadSeq).toBe(2);
  });

  it('rejects sending/listing/reading an unknown or foreign channel id', async () => {
    expect((await inject('POST', `/api/conversations/${convId}/messages`, ownerCookie, { ciphertext: 'c', iv: 'i', epoch: 0, channelId: 'nope_____' })).statusCode).toBe(404);
    expect((await inject('GET', `/api/conversations/${convId}/messages?channelId=nope_____`, ownerCookie)).statusCode).toBe(404);
    expect((await inject('POST', `/api/conversations/${convId}/read`, ownerCookie, { seq: 1, channelId: 'nope_____' })).statusCode).toBe(404);
    // a channel that belongs to a *different* conversation is foreign here.
    const other = (await inject('POST', '/api/conversations/group', ownerCookie, { members: keysFor([owner, a, b]) })).json().id;
    await inject('POST', `/api/conversations/${other}/channels`, ownerCookie, { name: 'x', type: 'text' });
    const foreign = (await channelsOf(owner, other)).find((c) => !c.isDefault)!;
    expect((await inject('GET', `/api/conversations/${convId}/messages?channelId=${foreign.id}`, ownerCookie)).statusCode).toBe(404);
  });
});

describe('channels — reactions are filed to the message’s channel', () => {
  it('derives the reaction channel from the target message, scoping reaction lists', async () => {
    await createChannel('random');
    const ch = (await channelsOf(owner, convId)).find((c) => !c.isDefault)!;
    await inject('POST', `/api/conversations/${convId}/messages`, ownerCookie, { ciphertext: 'g', iv: 'i', epoch: 0 }); // seq 1, general
    await inject('POST', `/api/conversations/${convId}/messages`, ownerCookie, { ciphertext: 'c', iv: 'i', epoch: 0, channelId: ch.id }); // seq 2, channel
    await inject('POST', `/api/conversations/${convId}/messages/2/reactions`, ownerCookie, { ciphertext: 'r', iv: 'i' });
    const general = (await inject('GET', `/api/conversations/${convId}/reactions`, ownerCookie)).json();
    const inChannel = (await inject('GET', `/api/conversations/${convId}/reactions?channelId=${ch.id}`, ownerCookie)).json();
    expect(general).toHaveLength(0);
    expect(inChannel).toHaveLength(1);
    expect(inChannel[0].channelId).toBe(ch.id);
    expect(inChannel[0].seq).toBe(2);
  });
});
