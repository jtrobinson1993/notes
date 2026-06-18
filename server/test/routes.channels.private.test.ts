import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authCookie, makeApp, makeFriends, seedUser, type TestApp } from '../../test/helpers/server.js';
import type { ChannelInfo, Conversation } from '@notes/shared';

const SEALED = { epk: 'AAAA', iv: 'BBBB', ct: 'CCCC' };

let t: TestApp;
let owner: string;
let a: string;
let b: string;
let ownerCookie: string;
let convId: string;

function inject(method: string, url: string, cookie?: string, payload?: unknown) {
  return t.app.inject({ method: method as 'GET', url, headers: cookie ? { cookie } : {}, payload: payload as object });
}
const keysFor = (ids: string[]) => ids.map((userId) => ({ userId, sealedKey: SEALED }));
const channelsOf = async (userId: string): Promise<ChannelInfo[]> =>
  (((await inject('GET', '/api/conversations', authCookie(t.db, userId))).json() as Conversation[]).find((c) => c.id === convId)?.channels) ?? [];
const privOf = async (userId: string) => (await channelsOf(userId)).find((c) => !c.isDefault);

beforeEach(async () => {
  t = await makeApp();
  owner = seedUser(t.db, { publicKey: 'pk-o' });
  a = seedUser(t.db, { publicKey: 'pk-a' });
  b = seedUser(t.db, { publicKey: 'pk-b' });
  for (const u of [a, b]) makeFriends(t.db, owner, u);
  makeFriends(t.db, a, b);
  ownerCookie = authCookie(t.db, owner);
  convId = (await inject('POST', '/api/conversations/group', ownerCookie, { members: keysFor([owner, a, b]) })).json().id;
});
afterEach(() => t.cleanup());

// Create a private channel with the given members (owner included).
const createPrivate = (members: string[]) =>
  inject('POST', `/api/conversations/${convId}/channels`, ownerCookie, { name: 'secret', type: 'text', private: true, members: keysFor(members) });

describe('private channels — creation + visibility', () => {
  it('creates a private channel visible only to its members', async () => {
    expect((await createPrivate([owner, a])).statusCode).toBe(200);
    const o = await privOf(owner);
    expect(o).toMatchObject({ private: true, channelEpoch: 0 });
    expect(o!.memberIds.sort()).toEqual([owner, a].sort());
    expect(o!.channelKeys.length).toBe(1); // epoch 0 sealed to me
    expect(await privOf(a)).toBeTruthy();
    expect(await privOf(b)).toBeUndefined(); // b is a conv member but not a channel member
  });

  it('rejects a private channel without the creator, or with a non-member', async () => {
    expect((await inject('POST', `/api/conversations/${convId}/channels`, ownerCookie, { name: 'x', type: 'text', private: true, members: keysFor([a]) })).statusCode).toBe(400);
    const outsider = seedUser(t.db);
    expect((await inject('POST', `/api/conversations/${convId}/channels`, ownerCookie, { name: 'x', type: 'text', private: true, members: keysFor([owner, outsider]) })).statusCode).toBe(400);
  });

  it('blocks a non-member from reading or posting to the private channel', async () => {
    await createPrivate([owner, a]);
    const cid = (await privOf(owner))!.id;
    const bCookie = authCookie(t.db, b);
    expect((await inject('GET', `/api/conversations/${convId}/messages?channelId=${cid}`, bCookie)).statusCode).toBe(404);
    expect((await inject('POST', `/api/conversations/${convId}/messages`, bCookie, { ciphertext: 'c', iv: 'i', epoch: 0, channelId: cid })).statusCode).toBe(404);
    // A member can post.
    expect((await inject('POST', `/api/conversations/${convId}/messages`, ownerCookie, { ciphertext: 'c', iv: 'i', epoch: 0, channelId: cid })).statusCode).toBe(200);
  });
});

describe('private channels — grant + revoke (re-key)', () => {
  it('grants b access at a new epoch, then revokes a', async () => {
    await createPrivate([owner, a]);
    const cid = (await privOf(owner))!.id;

    // Grant b → new epoch 1, sealed to owner+a+b.
    const grant = await inject('POST', `/api/conversations/${convId}/channels/${cid}/members`, ownerCookie, {
      userId: b, epoch: 1, history: 'fresh', keys: keysFor([owner, a, b]),
    });
    expect(grant.statusCode).toBe(200);
    expect((await privOf(b))!.memberIds.sort()).toEqual([owner, a, b].sort());
    expect((await privOf(owner))!.channelEpoch).toBe(1);

    // Revoke a → new epoch 2, sealed to owner+b.
    const revoke = await inject('DELETE', `/api/conversations/${convId}/channels/${cid}/members/${a}`, ownerCookie, {
      epoch: 2, keys: keysFor([owner, b]),
    });
    expect(revoke.statusCode).toBe(200);
    expect(await privOf(a)).toBeUndefined(); // a lost access
    expect((await privOf(owner))!.memberIds.sort()).toEqual([owner, b].sort());
    expect((await privOf(owner))!.channelEpoch).toBe(2);
  });

  it('rejects grant/revoke with a wrong epoch or incomplete keys', async () => {
    await createPrivate([owner, a]);
    const cid = (await privOf(owner))!.id;
    // wrong epoch
    expect((await inject('POST', `/api/conversations/${convId}/channels/${cid}/members`, ownerCookie, { userId: b, epoch: 5, history: 'fresh', keys: keysFor([owner, a, b]) })).statusCode).toBe(409);
    // keys missing a member
    expect((await inject('POST', `/api/conversations/${convId}/channels/${cid}/members`, ownerCookie, { userId: b, epoch: 1, history: 'fresh', keys: keysFor([owner, b]) })).statusCode).toBe(400);
  });
});
