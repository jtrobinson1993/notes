import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { effectiveDisplayName } from '../src/db.js';
import { makeDb, seedUser, type TestDb } from '../../test/helpers/server.js';

let t: TestDb;
beforeEach(() => {
  t = makeDb();
});
afterEach(() => t.cleanup());

describe('users + display name', () => {
  it('stores and reads back a user', () => {
    const id = seedUser(t.db, { username: 'alice', role: 'admin' });
    const u = t.db.getUser(id)!;
    expect(u.username).toBe('alice');
    expect(u.role).toBe('admin');
  });

  it('username lookup is case-insensitive (UNIQUE NOCASE)', () => {
    seedUser(t.db, { username: 'Alice' });
    expect(t.db.getUserByUsername('alice')).toBeDefined();
  });

  it('effectiveDisplayName uses the set name, else a stable User-xxxxxx fallback', () => {
    const id = seedUser(t.db, { id: 'abcdef123456', username: 'bob' });
    expect(effectiveDisplayName(t.db.getUser(id)!)).toBe('User-abcdef');
    t.db.setDisplayName(id, 'Bobby');
    expect(effectiveDisplayName(t.db.getUser(id)!)).toBe('Bobby');
  });

  it('never falls back to the username (privacy)', () => {
    const id = seedUser(t.db, { username: 'secret-login-name' });
    expect(effectiveDisplayName(t.db.getUser(id)!)).not.toContain('secret-login-name');
  });
});

describe('invite → request → accept → two-way friends', () => {
  it('walks the full friendship lifecycle', () => {
    const owner = seedUser(t.db);
    const joiner = seedUser(t.db);
    t.db.createFriendInvite({ id: 'inv1', token: 'tok-abc', createdBy: owner, expiresAt: Date.now() + 60_000 });

    const invite = t.db.getFriendInviteByToken('tok-abc')!;
    expect(invite.created_by).toBe(owner);

    t.db.createFriendRequest({ id: 'req1', fromUser: joiner, toUser: owner });
    expect(t.db.getFriendRequestBetween(owner, joiner)).toBeDefined();

    t.db.addFriendPair(owner, joiner);
    t.db.deleteFriendRequest('req1');

    expect(t.db.areFriends(owner, joiner)).toBe(true);
    expect(t.db.areFriends(joiner, owner)).toBe(true);
    expect(t.db.getFriendRequestBetween(owner, joiner)).toBeUndefined();
  });

  it('getFriendRequestBetween finds a request in either direction', () => {
    const a = seedUser(t.db);
    const b = seedUser(t.db);
    t.db.createFriendRequest({ id: 'r', fromUser: a, toUser: b });
    expect(t.db.getFriendRequestBetween(a, b)).toBeDefined();
    expect(t.db.getFriendRequestBetween(b, a)).toBeDefined();
  });

  it('unfriend removes both directional rows', () => {
    const a = seedUser(t.db);
    const b = seedUser(t.db);
    t.db.addFriendPair(a, b);
    t.db.deleteFriendPair(a, b);
    expect(t.db.areFriends(a, b)).toBe(false);
    expect(t.db.areFriends(b, a)).toBe(false);
    expect(t.db.listFriendIds(a)).toEqual([]);
    expect(t.db.listFriendIds(b)).toEqual([]);
  });
});

describe('friend invites — expiry (lazy + sweep)', () => {
  it('lazily deletes an expired invite on lookup', () => {
    const owner = seedUser(t.db);
    t.db.createFriendInvite({ id: 'inv', token: 'expired', createdBy: owner, expiresAt: Date.now() - 1 });
    expect(t.db.getFriendInviteByToken('expired')).toBeUndefined();
    // The lazy lookup also removed the row.
    expect(t.db.raw.prepare('SELECT COUNT(*) AS c FROM friend_invites').get()).toMatchObject({ c: 0 });
  });

  it('listFriendInvites hides expired invites', () => {
    const owner = seedUser(t.db);
    t.db.createFriendInvite({ id: 'live', token: 't1', createdBy: owner, expiresAt: Date.now() + 60_000 });
    t.db.createFriendInvite({ id: 'dead', token: 't2', createdBy: owner, expiresAt: Date.now() - 1 });
    const ids = t.db.listFriendInvites(owner).map((i) => i.id);
    expect(ids).toEqual(['live']);
  });

  it('purgeExpiredInvites sweeps all expired rows', () => {
    const owner = seedUser(t.db);
    t.db.createFriendInvite({ id: 'live', token: 't1', createdBy: owner, expiresAt: Date.now() + 60_000 });
    t.db.createFriendInvite({ id: 'dead', token: 't2', createdBy: owner, expiresAt: Date.now() - 1 });
    t.db.purgeExpiredInvites();
    const rows = t.db.raw.prepare('SELECT id FROM friend_invites').all() as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(['live']);
  });
});

describe('conversations + dm_key uniqueness', () => {
  it('rejects a duplicate dm_key', () => {
    const me = seedUser(t.db);
    const you = seedUser(t.db);
    const dmKey = me < you ? `${me}:${you}` : `${you}:${me}`;
    t.db.createConversation({ id: 'c1', kind: 'dm', createdBy: me, dmKey });
    expect(() =>
      t.db.createConversation({ id: 'c2', kind: 'dm', createdBy: me, dmKey }),
    ).toThrow();
  });

  it('allows multiple null-dm_key conversations (groups)', () => {
    const me = seedUser(t.db);
    expect(() => {
      t.db.createConversation({ id: 'g1', kind: 'group', createdBy: me, dmKey: null });
      t.db.createConversation({ id: 'g2', kind: 'group', createdBy: me, dmKey: null });
    }).not.toThrow();
  });

  it('getConversationByDmKey finds the conversation', () => {
    const me = seedUser(t.db);
    t.db.createConversation({ id: 'c1', kind: 'dm', createdBy: me, dmKey: 'a:b' });
    expect(t.db.getConversationByDmKey('a:b')?.id).toBe('c1');
  });
});

describe('messages — seq monotonicity', () => {
  function setupConv(): { conv: string; me: string; you: string } {
    const me = seedUser(t.db);
    const you = seedUser(t.db);
    t.db.createConversation({ id: 'c1', kind: 'dm', createdBy: me, dmKey: 'a:b' });
    t.db.addConversationMember({ conversationId: 'c1', userId: me, sealedKey: '{}', epoch: 0 });
    t.db.addConversationMember({ conversationId: 'c1', userId: you, sealedKey: '{}', epoch: 0 });
    return { conv: 'c1', me, you };
  }

  it('assigns 1,2,3,... and getMaxSeq tracks the head', () => {
    const { conv, me } = setupConv();
    expect(t.db.getMaxSeq(conv)).toBe(0);
    const seqs = [0, 1, 2, 3].map((i) =>
      t.db.insertMessage({ id: `m${i}`, conversationId: conv, senderId: me, epoch: 0, ciphertext: 'c', iv: 'i' }).seq,
    );
    expect(seqs).toEqual([1, 2, 3, 4]);
    expect(t.db.getMaxSeq(conv)).toBe(4);
  });

  it('rejects a duplicate (conversation, seq) pair', () => {
    const { conv, me } = setupConv();
    t.db.raw
      .prepare('INSERT INTO messages (id,conversation_id,sender_id,seq,epoch,ciphertext,iv,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('x', conv, me, 5, 0, 'c', 'i', Date.now());
    expect(() =>
      t.db.raw
        .prepare('INSERT INTO messages (id,conversation_id,sender_id,seq,epoch,ciphertext,iv,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run('y', conv, me, 5, 0, 'c', 'i', Date.now()),
    ).toThrow();
  });

  it('listMessages paginates DESC with an exclusive before cursor', () => {
    const { conv, me } = setupConv();
    for (let i = 0; i < 5; i++) {
      t.db.insertMessage({ id: `m${i}`, conversationId: conv, senderId: me, epoch: 0, ciphertext: 'c', iv: 'i' });
    }
    const head = t.db.listMessages(conv, undefined, 2).map((m) => m.seq);
    expect(head).toEqual([5, 4]);
    const older = t.db.listMessages(conv, 4, 2).map((m) => m.seq);
    expect(older).toEqual([3, 2]);
  });
});

describe('last_read_seq never decreases', () => {
  it('advances forward but ignores backward moves (MAX)', () => {
    const me = seedUser(t.db);
    t.db.createConversation({ id: 'c1', kind: 'dm', createdBy: me, dmKey: 'a:b' });
    t.db.addConversationMember({ conversationId: 'c1', userId: me, sealedKey: '{}', epoch: 0 });

    t.db.setLastReadSeq('c1', me, 5);
    expect(t.db.getConversationMember('c1', me)!.last_read_seq).toBe(5);
    t.db.setLastReadSeq('c1', me, 3); // backward → ignored
    expect(t.db.getConversationMember('c1', me)!.last_read_seq).toBe(5);
    t.db.setLastReadSeq('c1', me, 8); // forward → advances
    expect(t.db.getConversationMember('c1', me)!.last_read_seq).toBe(8);
  });
});
