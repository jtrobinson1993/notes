import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authCookie, makeApp, makeFriends, seedUser, type TestApp } from '../../test/helpers/server.js';

const SEALED = { epk: 'AAAA', iv: 'BBBB', ct: 'CCCC' };

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(() => t.cleanup());

function get(url: string, cookie: string) {
  return t.app.inject({ method: 'GET', url, headers: { cookie } });
}

describe('GET list endpoints', () => {
  it('GET /api/profile returns the display name (and the privacy fallback)', async () => {
    const named = authCookie(t.db, seedUser(t.db, { displayName: 'Alice' }));
    expect((await get('/api/profile', named)).json()).toEqual({ displayName: 'Alice', handle: expect.any(String), nameColor: null, friendsOnly: true, linkPreviews: false });

    const id = seedUser(t.db, { id: 'abcdef000000' }); // no display name set
    const res = await get('/api/profile', authCookie(t.db, id));
    expect(res.json().displayName).toBe('User-abcdef');
  });

  it('GET /api/friends lists confirmed friends with display name + presence', async () => {
    const me = seedUser(t.db);
    const f = seedUser(t.db, { id: 'fr', displayName: 'Buddy', publicKey: 'pk' });
    makeFriends(t.db, me, f);
    const res = await get('/api/friends', authCookie(t.db, me));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ userId: 'fr', displayName: 'Buddy', handle: expect.any(String), publicKey: 'pk', online: false }]);
  });

  it('GET /api/friends/requests shows incoming and outgoing requests', async () => {
    const me = seedUser(t.db, { displayName: 'Me' });
    const other = seedUser(t.db, { id: 'oth', displayName: 'Other' });
    t.db.createFriendRequest({ id: 'r1', fromUser: other, toUser: me }); // incoming
    t.db.createFriendRequest({ id: 'r2', fromUser: me, toUser: other }); // outgoing (reverse)
    const res = await get('/api/friends/requests', authCookie(t.db, me));
    const byId = Object.fromEntries((res.json() as any[]).map((r) => [r.id, r]));
    expect(byId.r1).toMatchObject({ direction: 'incoming', userId: 'oth', displayName: 'Other' });
    expect(byId.r2).toMatchObject({ direction: 'outgoing', userId: 'oth' });
  });

  it('GET /api/friend-invites lists the caller’s live invites', async () => {
    const me = seedUser(t.db);
    t.db.createFriendInvite({ id: 'i1', token: 'tok', createdBy: me, expiresAt: Date.now() + 60_000 });
    const res = await get('/api/friend-invites', authCookie(t.db, me));
    expect(res.json().map((i: any) => i.id)).toEqual(['i1']);
    expect(res.json()[0].token).toBe('tok');
  });

  it('GET /api/conversations returns the caller’s DMs with members', async () => {
    const me = seedUser(t.db, { displayName: 'Me' });
    const friend = seedUser(t.db, { id: 'fr', displayName: 'Friend' });
    makeFriends(t.db, me, friend);
    t.db.createConversation({ id: 'c1', kind: 'dm', createdBy: me, dmKey: 'a:b' });
    t.db.addConversationMember({ conversationId: 'c1', userId: me, sealedKey: JSON.stringify(SEALED), epoch: 0 });
    t.db.addConversationMember({ conversationId: 'c1', userId: friend, sealedKey: JSON.stringify(SEALED), epoch: 0 });

    const res = await get('/api/conversations', authCookie(t.db, me));
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'c1', kind: 'dm', sealedKey: SEALED });
    expect(list[0].members.map((m: any) => m.displayName).sort()).toEqual(['Friend', 'Me']);
  });

  it('GET /api/conversations omits a DM once the friendship is gone', async () => {
    const me = seedUser(t.db);
    const friend = seedUser(t.db, { id: 'fr' });
    makeFriends(t.db, me, friend);
    t.db.createConversation({ id: 'c1', kind: 'dm', createdBy: me, dmKey: 'a:b' });
    t.db.addConversationMember({ conversationId: 'c1', userId: me, sealedKey: JSON.stringify(SEALED), epoch: 0 });
    t.db.addConversationMember({ conversationId: 'c1', userId: friend, sealedKey: JSON.stringify(SEALED), epoch: 0 });
    t.db.deleteFriendPair(me, friend);
    expect((await get('/api/conversations', authCookie(t.db, me))).json()).toEqual([]);
  });
});
