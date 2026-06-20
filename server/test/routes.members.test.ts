import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authCookie, makeApp, makeFriends, seedUser, type TestApp } from '../../test/helpers/server.js';

const SEALED = { epk: 'AAAA', iv: 'BBBB', ct: 'CCCC' };

let t: TestApp;
let owner: string;
let a: string;
let b: string;
let c: string;
let ownerCookie: string;
let convId: string;

function inject(method: string, url: string, cookie?: string, payload?: unknown) {
  return t.app.inject({ method: method as 'GET', url, headers: cookie ? { cookie } : {}, payload: payload as object });
}

/** Sealed-key list covering exactly the given members (crypto is opaque here). */
const keysFor = (ids: string[]) => ids.map((userId) => ({ userId, sealedKey: SEALED }));

async function convsFor(userId: string) {
  return (await inject('GET', '/api/conversations', authCookie(t.db, userId))).json() as { id: string; epoch: number; members: { userId: string; role: string }[] }[];
}
const findConv = async (userId: string) => (await convsFor(userId)).find((c) => c.id === convId);

beforeEach(async () => {
  t = await makeApp();
  owner = seedUser(t.db, { publicKey: 'pk-o' });
  a = seedUser(t.db, { publicKey: 'pk-a' });
  b = seedUser(t.db, { publicKey: 'pk-b' });
  c = seedUser(t.db, { publicKey: 'pk-c' });
  for (const u of [a, b, c]) makeFriends(t.db, owner, u);
  ownerCookie = authCookie(t.db, owner);
  // A group of {owner, a, b} at epoch 0; owner is the creator.
  const res = await inject('POST', '/api/conversations/group', ownerCookie, { members: keysFor([owner, a, b]) });
  convId = res.json().id;
});
afterEach(() => t.cleanup());

describe('group create roles', () => {
  it('marks the creator owner and the rest members', async () => {
    const conv = await findConv(owner);
    expect(conv?.members.find((m) => m.userId === owner)?.role).toBe('owner');
    expect(conv?.members.find((m) => m.userId === a)?.role).toBe('member');
  });
});

describe('add member', () => {
  const addBody = (history: 'share' | 'fresh', epoch = 1) => ({
    userId: c,
    epoch,
    history,
    keys: keysFor([owner, a, b, c]),
    priorKeys: [{ epoch: 0, sealedKey: SEALED }],
  });

  it('owner adds a friend, bumping the epoch and sealing to everyone', async () => {
    const res = await inject('POST', `/api/conversations/${convId}/members`, ownerCookie, addBody('share'));
    expect(res.statusCode).toBe(200);
    expect(res.json().epoch).toBe(1);
    expect(res.json().members).toHaveLength(4);
    // The joiner sees the group, gets both epoch keys (share-history), at epoch 1.
    const forC = await findConv(c);
    expect(forC?.members).toHaveLength(4);
    expect(forC?.epoch).toBe(1);
    expect(forC?.epochKeys.map((k: { epoch: number }) => k.epoch).sort()).toEqual([0, 1]);
    // An existing member is re-keyed to epoch 1 and keeps epoch 0 too.
    const forA = await findConv(a);
    expect(forA?.epoch).toBe(1);
    expect(forA?.epochKeys.map((k: { epoch: number }) => k.epoch).sort()).toEqual([0, 1]);
  });

  it('fresh-history joiner gets only the new epoch key and a zeroed unread', async () => {
    await inject('POST', `/api/conversations/${convId}/messages`, ownerCookie, { ciphertext: 'm', iv: 'i', epoch: 0 });
    const res = await inject('POST', `/api/conversations/${convId}/members`, ownerCookie, {
      userId: c, epoch: 1, history: 'fresh', keys: keysFor([owner, a, b, c]),
    });
    expect(res.statusCode).toBe(200);
    const forC = await findConv(c);
    expect(forC?.epochKeys.map((k: { epoch: number }) => k.epoch)).toEqual([1]);
    // Unread baseline starts at the latest seq (they don't see prior messages).
    expect(forC?.lastReadSeq).toBe(forC?.lastSeq);
  });

  it('does not serve a fresh-history joiner any pre-join messages', async () => {
    // Two messages exist before c joins.
    await inject('POST', `/api/conversations/${convId}/messages`, ownerCookie, { ciphertext: 'old1', iv: 'i', epoch: 0 });
    await inject('POST', `/api/conversations/${convId}/messages`, ownerCookie, { ciphertext: 'old2', iv: 'i', epoch: 0 });
    await inject('POST', `/api/conversations/${convId}/members`, ownerCookie, {
      userId: c, epoch: 1, history: 'fresh', keys: keysFor([owner, a, b, c]),
    });
    // A message posted after c joins.
    await inject('POST', `/api/conversations/${convId}/messages`, ownerCookie, { ciphertext: 'new', iv: 'i', epoch: 1 });

    const cMsgs = (await inject('GET', `/api/conversations/${convId}/messages`, authCookie(t.db, c))).json() as { ciphertext: string }[];
    expect(cMsgs.map((m) => m.ciphertext)).toEqual(['new']); // the server never sends old1/old2
    // The owner (full history) still sees everything.
    const ownerMsgs = (await inject('GET', `/api/conversations/${convId}/messages`, ownerCookie)).json() as { ciphertext: string }[];
    expect(ownerMsgs.map((m) => m.ciphertext).sort()).toEqual(['new', 'old1', 'old2']);
  });

  it('still serves a share-history joiner the full history', async () => {
    await inject('POST', `/api/conversations/${convId}/messages`, ownerCookie, { ciphertext: 'old', iv: 'i', epoch: 0 });
    await inject('POST', `/api/conversations/${convId}/members`, ownerCookie, addBody('share'));
    const cMsgs = (await inject('GET', `/api/conversations/${convId}/messages`, authCookie(t.db, c))).json() as { ciphertext: string }[];
    expect(cMsgs.map((m) => m.ciphertext)).toEqual(['old']);
  });

  it('rejects the wrong epoch, a non-friend, an existing member, and bad coverage', async () => {
    expect((await inject('POST', `/api/conversations/${convId}/members`, ownerCookie, addBody('share', 2))).statusCode).toBe(409);
    expect((await inject('POST', `/api/conversations/${convId}/members`, ownerCookie, { ...addBody('share'), userId: a })).statusCode).toBe(409);
    const stranger = seedUser(t.db, { publicKey: 'pk-x' });
    expect((await inject('POST', `/api/conversations/${convId}/members`, ownerCookie, { ...addBody('share'), userId: stranger, keys: keysFor([owner, a, b, stranger]) })).statusCode).toBe(400);
    // keys missing a current member
    expect((await inject('POST', `/api/conversations/${convId}/members`, ownerCookie, { ...addBody('share'), keys: keysFor([owner, a, c]) })).statusCode).toBe(400);
    // share-history without all prior epoch keys
    expect((await inject('POST', `/api/conversations/${convId}/members`, ownerCookie, { ...addBody('share'), priorKeys: [] })).statusCode).toBe(400);
  });

  it('a plain member cannot add', async () => {
    const res = await inject('POST', `/api/conversations/${convId}/members`, authCookie(t.db, a), addBody('share'));
    expect(res.statusCode).toBe(403);
  });

  it('an admin can add (admins have owner-level powers)', async () => {
    await inject('POST', `/api/conversations/${convId}/members/${a}/role`, ownerCookie, { role: 'admin' });
    makeFriends(t.db, a, c); // a adds their own friend
    const res = await inject('POST', `/api/conversations/${convId}/members`, authCookie(t.db, a), addBody('share'));
    expect(res.statusCode).toBe(200);
  });
});

describe('remove / leave', () => {
  const removeBody = (remaining: string[], epoch = 1) => ({ epoch, keys: keysFor(remaining) });

  it('owner removes a member, re-keying the remainder and revoking the target', async () => {
    const res = await inject('DELETE', `/api/conversations/${convId}/members/${b}`, ownerCookie, removeBody([owner, a]));
    expect(res.statusCode).toBe(200);
    expect(await findConv(b)).toBeUndefined(); // removed user no longer sees it
    // ...and can't read it any more.
    expect((await inject('GET', `/api/conversations/${convId}/messages`, authCookie(t.db, b))).statusCode).toBe(403);
    expect((await findConv(owner))?.epoch).toBe(1);
  });

  it('a plain member cannot remove others, nor can anyone remove the owner', async () => {
    expect((await inject('DELETE', `/api/conversations/${convId}/members/${b}`, authCookie(t.db, a), removeBody([owner, b]))).statusCode).toBe(403);
    expect((await inject('DELETE', `/api/conversations/${convId}/members/${owner}`, authCookie(t.db, a), removeBody([a, b]))).statusCode).toBe(403);
  });

  it('a member can leave on their own', async () => {
    const res = await inject('DELETE', `/api/conversations/${convId}/members/${a}`, authCookie(t.db, a), removeBody([owner, b]));
    expect(res.statusCode).toBe(200);
    expect(await findConv(a)).toBeUndefined();
  });

  it('refuses to drop below two members', async () => {
    await inject('DELETE', `/api/conversations/${convId}/members/${b}`, ownerCookie, removeBody([owner, a]));
    const res = await inject('DELETE', `/api/conversations/${convId}/members/${a}`, ownerCookie, { epoch: 2, keys: keysFor([owner]) });
    expect(res.statusCode).toBe(400);
  });

  it('owner leaving transfers ownership to exactly one remaining member', async () => {
    const res = await inject('DELETE', `/api/conversations/${convId}/members/${owner}`, ownerCookie, removeBody([a, b]));
    expect(res.statusCode).toBe(200);
    const remaining = (await findConv(a))?.members ?? [];
    expect(remaining.map((m) => m.userId).sort()).toEqual([a, b].sort());
    expect(remaining.filter((m) => m.role === 'owner')).toHaveLength(1);
  });
});

const promote = (uid: string) =>
  inject('POST', `/api/conversations/${convId}/members/${uid}/role`, ownerCookie, { role: 'admin' });

describe('roles', () => {
  it('owner grants admin; a plain member cannot change roles but an admin can', async () => {
    expect((await inject('POST', `/api/conversations/${convId}/members/${b}/role`, authCookie(t.db, a), { role: 'admin' })).statusCode).toBe(403);
    expect((await promote(a)).statusCode).toBe(200);
    expect((await findConv(owner))?.members.find((m) => m.userId === a)?.role).toBe('admin');
    // The admin can now promote another member.
    expect((await inject('POST', `/api/conversations/${convId}/members/${b}/role`, authCookie(t.db, a), { role: 'admin' })).statusCode).toBe(200);
  });

  it("nobody can change the owner's role or their own", async () => {
    await promote(a);
    expect((await inject('POST', `/api/conversations/${convId}/members/${owner}/role`, authCookie(t.db, a), { role: 'member' })).statusCode).toBe(403);
    expect((await inject('POST', `/api/conversations/${convId}/members/${a}/role`, authCookie(t.db, a), { role: 'member' })).statusCode).toBe(400);
  });

  it('an admin can remove a member but not the owner', async () => {
    await promote(a);
    expect((await inject('DELETE', `/api/conversations/${convId}/members/${b}`, authCookie(t.db, a), { epoch: 1, keys: keysFor([owner, a]) })).statusCode).toBe(200);
    expect((await inject('DELETE', `/api/conversations/${convId}/members/${owner}`, authCookie(t.db, a), { epoch: 1, keys: keysFor([a, b]) })).statusCode).toBe(403);
  });
});
