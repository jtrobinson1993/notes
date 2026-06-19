import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authCookie, makeApp, makeFriends, seedUser, type TestApp } from '../../test/helpers/server.js';
import type { Conversation } from '@notes/shared';

const SEALED = { epk: 'AAAA', iv: 'BBBB', ct: 'CCCC' };
const ICON = { ciphertext: 'Y2lwaGVy', iv: 'aXY=', epoch: 0 };

let t: TestApp;
let owner: string;
let admin: string;
let member: string;
let convId: string;
let dmId: string;

function inject(method: string, url: string, cookie?: string, payload?: unknown) {
  return t.app.inject({ method: method as 'GET', url, headers: cookie ? { cookie } : {}, payload: payload as object });
}
const keysFor = (ids: string[]) => ids.map((userId) => ({ userId, sealedKey: SEALED }));
const getConv = async (userId: string, id: string): Promise<Conversation | undefined> =>
  ((await inject('GET', '/api/conversations', authCookie(t.db, userId))).json() as Conversation[]).find((c) => c.id === id);

beforeEach(async () => {
  t = await makeApp();
  owner = seedUser(t.db, { publicKey: 'pk-o' });
  admin = seedUser(t.db, { publicKey: 'pk-a' });
  member = seedUser(t.db, { publicKey: 'pk-m' });
  for (const u of [admin, member]) makeFriends(t.db, owner, u);
  makeFriends(t.db, admin, member);
  convId = (await inject('POST', '/api/conversations/group', authCookie(t.db, owner), { members: keysFor([owner, admin, member]) })).json().id;
  await inject('POST', `/api/conversations/${convId}/members/${admin}/role`, authCookie(t.db, owner), { role: 'admin' });
  dmId = (await inject('POST', '/api/conversations/dm', authCookie(t.db, owner), { friendId: admin, members: keysFor([owner, admin]) })).json().id;
});
afterEach(() => t.cleanup());

const patch = (userId: string, body: unknown, id = convId) => inject('PATCH', `/api/conversations/${id}`, authCookie(t.db, userId), body);

describe('PATCH /api/conversations/:id — group name', () => {
  it('lets the owner set + clear the name', async () => {
    expect((await patch(owner, { name: '  Squad  ' })).statusCode).toBe(200);
    expect((await getConv(member, convId))?.name).toBe('Squad'); // trimmed
    expect((await patch(owner, { name: '' })).statusCode).toBe(200);
    expect((await getConv(member, convId))?.name).toBeNull();
  });
  it('lets an admin rename', async () => {
    expect((await patch(admin, { name: 'Admins-can' })).statusCode).toBe(200);
    expect((await getConv(owner, convId))?.name).toBe('Admins-can');
  });
  it('forbids a plain member', async () => {
    expect((await patch(member, { name: 'nope' })).statusCode).toBe(403);
  });
  it('rejects an over-long name', async () => {
    expect((await patch(owner, { name: 'x'.repeat(61) })).statusCode).toBe(400);
  });
  it('404s on a DM (not a group)', async () => {
    expect((await patch(owner, { name: 'x' }, dmId)).statusCode).toBe(404);
  });
});

describe('PATCH /api/conversations/:id — group icon', () => {
  it('stores + clears a valid (opaque) icon', async () => {
    expect((await patch(owner, { icon: ICON })).statusCode).toBe(200);
    expect((await getConv(member, convId))?.icon).toEqual(ICON);
    expect((await patch(owner, { icon: null })).statusCode).toBe(200);
    expect((await getConv(member, convId))?.icon).toBeNull();
  });
  it('rejects a malformed icon', async () => {
    expect((await patch(owner, { icon: { ciphertext: 'x' } })).statusCode).toBe(400);
  });
});
