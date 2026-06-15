import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authCookie, makeApp, makeFriends, seedUser, type TestApp } from '../../test/helpers/server.js';

const SEALED = { epk: 'AAAA', iv: 'BBBB', ct: 'CCCC' };

let t: TestApp;
let me: string;
let friend: string;
let meCookie: string;
let convId: string;

function inject(method: string, url: string, cookie?: string, payload?: unknown) {
  return t.app.inject({ method: method as 'GET', url, headers: cookie ? { cookie } : {}, payload: payload as object });
}
const bothMembers = () => [
  { userId: me, sealedKey: SEALED },
  { userId: friend, sealedKey: SEALED },
];

beforeEach(async () => {
  t = await makeApp();
  me = seedUser(t.db, { publicKey: 'pkme' });
  friend = seedUser(t.db, { publicKey: 'pkfr' });
  makeFriends(t.db, me, friend);
  meCookie = authCookie(t.db, me);
  const dm = await inject('POST', '/api/conversations/dm', meCookie, { friendId: friend, members: bothMembers() });
  convId = dm.json().id;
  await inject('POST', `/api/conversations/${convId}/messages`, meCookie, { ciphertext: 'a', iv: 'i', epoch: 0 });
});
afterEach(() => t.cleanup());

describe('threads', () => {
  it('creates a thread rooted on a message, sealed to all parent members', async () => {
    const res = await inject('POST', `/api/conversations/${convId}/messages/1/thread`, meCookie, { members: bothMembers() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'thread', parentId: convId, parentSeq: 1 });
    expect(res.json().members).toHaveLength(2);
  });

  it('is idempotent — one thread per parent message', async () => {
    const a = await inject('POST', `/api/conversations/${convId}/messages/1/thread`, meCookie, { members: bothMembers() });
    const b = await inject('POST', `/api/conversations/${convId}/messages/1/thread`, meCookie, { members: bothMembers() });
    expect(b.statusCode).toBe(200);
    expect(b.json().id).toBe(a.json().id);
    expect(t.db.raw.prepare("SELECT COUNT(*) AS c FROM conversations WHERE kind='thread'").get()).toMatchObject({ c: 1 });
  });

  it('both members see the thread in their conversation list', async () => {
    await inject('POST', `/api/conversations/${convId}/messages/1/thread`, meCookie, { members: bothMembers() });
    const friendConvs = (await inject('GET', '/api/conversations', authCookie(t.db, friend))).json();
    expect(friendConvs.some((c: { kind: string; parentSeq: number }) => c.kind === 'thread' && c.parentSeq === 1)).toBe(true);
  });

  it('rejects members that do not match the parent', async () => {
    const res = await inject('POST', `/api/conversations/${convId}/messages/1/thread`, meCookie, { members: [{ userId: me, sealedKey: SEALED }] });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a non-member and an invalid seq', async () => {
    const outsider = authCookie(t.db, seedUser(t.db));
    expect((await inject('POST', `/api/conversations/${convId}/messages/1/thread`, outsider, { members: bothMembers() })).statusCode).toBe(403);
    expect((await inject('POST', `/api/conversations/${convId}/messages/0/thread`, meCookie, { members: bothMembers() })).statusCode).toBe(400);
    expect((await inject('POST', `/api/conversations/${convId}/messages/99/thread`, meCookie, { members: bothMembers() })).statusCode).toBe(400);
  });

  it('cannot thread a thread', async () => {
    const thread = (await inject('POST', `/api/conversations/${convId}/messages/1/thread`, meCookie, { members: bothMembers() })).json();
    await inject('POST', `/api/conversations/${thread.id}/messages`, meCookie, { ciphertext: 'x', iv: 'i', epoch: 0 });
    const res = await inject('POST', `/api/conversations/${thread.id}/messages/1/thread`, meCookie, { members: bothMembers() });
    expect(res.statusCode).toBe(400);
  });
});
