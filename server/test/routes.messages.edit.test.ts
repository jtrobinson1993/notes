import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authCookie, makeApp, makeFriends, seedUser, type TestApp } from '../../test/helpers/server.js';

const SEALED = { epk: 'AAAA', iv: 'BBBB', ct: 'CCCC' };

let t: TestApp;
let me: string;
let friend: string;
let meCookie: string;
let friendCookie: string;
let convId: string;

function inject(method: string, url: string, cookie?: string, payload?: unknown) {
  return t.app.inject({ method: method as 'GET', url, headers: cookie ? { cookie } : {}, payload: payload as object });
}

beforeEach(async () => {
  t = await makeApp();
  me = seedUser(t.db, { publicKey: 'pkme' });
  friend = seedUser(t.db, { publicKey: 'pkfr' });
  makeFriends(t.db, me, friend);
  meCookie = authCookie(t.db, me);
  friendCookie = authCookie(t.db, friend);
  const dm = await inject('POST', '/api/conversations/dm', meCookie, {
    friendId: friend,
    members: [
      { userId: me, sealedKey: SEALED },
      { userId: friend, sealedKey: SEALED },
    ],
  });
  convId = dm.json().id;
  await inject('POST', `/api/conversations/${convId}/messages`, meCookie, { ciphertext: 'orig', iv: 'iv0', epoch: 0 });
});
afterEach(() => t.cleanup());

describe('message editing', () => {
  it('rejects the unauthenticated', async () => {
    expect((await inject('PATCH', `/api/conversations/${convId}/messages/1`, undefined, { ciphertext: 'x', iv: 'i' })).statusCode).toBe(401);
  });

  it('lets the sender edit: replaces ciphertext and stamps editedAt', async () => {
    const res = await inject('PATCH', `/api/conversations/${convId}/messages/1`, meCookie, { ciphertext: 'EDITED', iv: 'iv1' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ conversationId: convId, seq: 1, ciphertext: 'EDITED', iv: 'iv1' });
    expect(typeof body.editedAt).toBe('number');

    // persisted + visible to the other member
    const list = await inject('GET', `/api/conversations/${convId}/messages`, friendCookie);
    const msg = list.json().find((m: { seq: number }) => m.seq === 1);
    expect(msg.ciphertext).toBe('EDITED');
    expect(msg.editedAt).toBe(body.editedAt);
  });

  it('a fresh message has no editedAt', async () => {
    const list = await inject('GET', `/api/conversations/${convId}/messages`, meCookie);
    expect(list.json()[0].editedAt).toBeUndefined();
  });

  it("forbids editing another user's message (IDOR via seq)", async () => {
    // friend is a member but not the sender of seq 1
    const res = await inject('PATCH', `/api/conversations/${convId}/messages/1`, friendCookie, { ciphertext: 'HIJACK', iv: 'iv' });
    expect(res.statusCode).toBe(403);
    // unchanged
    const list = await inject('GET', `/api/conversations/${convId}/messages`, meCookie);
    expect(list.json()[0].ciphertext).toBe('orig');
  });

  it('blocks non-members of the conversation', async () => {
    const outsider = authCookie(t.db, seedUser(t.db));
    expect((await inject('PATCH', `/api/conversations/${convId}/messages/1`, outsider, { ciphertext: 'x', iv: 'i' })).statusCode).toBe(403);
  });

  it('validates the payload', async () => {
    expect((await inject('PATCH', `/api/conversations/${convId}/messages/1`, meCookie, { iv: 'i' })).statusCode).toBe(400);
    expect((await inject('PATCH', `/api/conversations/${convId}/messages/1`, meCookie, { ciphertext: '', iv: 'i' })).statusCode).toBe(400);
    expect((await inject('PATCH', `/api/conversations/${convId}/messages/abc`, meCookie, { ciphertext: 'x', iv: 'i' })).statusCode).toBe(400);
  });

  it('403s a seq that does not exist (no row for this sender)', async () => {
    expect((await inject('PATCH', `/api/conversations/${convId}/messages/999`, meCookie, { ciphertext: 'x', iv: 'i' })).statusCode).toBe(403);
  });
});
