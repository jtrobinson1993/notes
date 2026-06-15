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
  await inject('POST', `/api/conversations/${convId}/messages`, meCookie, { ciphertext: 'a', iv: 'i', epoch: 0 });
});
afterEach(() => t.cleanup());

describe('reactions', () => {
  it('rejects the unauthenticated', async () => {
    expect((await inject('GET', `/api/conversations/${convId}/reactions`)).statusCode).toBe(401);
    expect((await inject('POST', `/api/conversations/${convId}/messages/1/reactions`, undefined, { ciphertext: 'c', iv: 'i' })).statusCode).toBe(401);
  });

  it('adds a reaction, returns it, and lists it (emoji opaque to the server)', async () => {
    const add = await inject('POST', `/api/conversations/${convId}/messages/1/reactions`, meCookie, { ciphertext: 'ENC', iv: 'iv' });
    expect(add.statusCode).toBe(200);
    expect(add.json()).toMatchObject({ conversationId: convId, seq: 1, userId: me, ciphertext: 'ENC' });

    const list = await inject('GET', `/api/conversations/${convId}/reactions`, friendCookie);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].ciphertext).toBe('ENC');
  });

  it('validates the payload', async () => {
    expect((await inject('POST', `/api/conversations/${convId}/messages/1/reactions`, meCookie, { iv: 'i' })).statusCode).toBe(400);
    expect((await inject('POST', `/api/conversations/${convId}/messages/0/reactions`, meCookie, { ciphertext: 'c', iv: 'i' })).statusCode).toBe(400);
  });

  it('blocks non-members (IDOR on the conversation)', async () => {
    const outsider = authCookie(t.db, seedUser(t.db));
    expect((await inject('GET', `/api/conversations/${convId}/reactions`, outsider)).statusCode).toBe(403);
    expect((await inject('POST', `/api/conversations/${convId}/messages/1/reactions`, outsider, { ciphertext: 'c', iv: 'i' })).statusCode).toBe(403);
  });

  it('only the owner can remove their reaction', async () => {
    const rid = (await inject('POST', `/api/conversations/${convId}/messages/1/reactions`, meCookie, { ciphertext: 'ENC', iv: 'iv' })).json().id;
    // friend (a member, but not the owner) cannot delete it
    expect((await inject('DELETE', `/api/conversations/${convId}/reactions/${rid}`, friendCookie)).statusCode).toBe(403);
    // owner can
    expect((await inject('DELETE', `/api/conversations/${convId}/reactions/${rid}`, meCookie)).statusCode).toBe(200);
    expect((await inject('GET', `/api/conversations/${convId}/reactions`, meCookie)).json()).toHaveLength(0);
  });

  it('404s a reaction id from another conversation', async () => {
    const rid = (await inject('POST', `/api/conversations/${convId}/messages/1/reactions`, meCookie, { ciphertext: 'ENC', iv: 'iv' })).json().id;
    // second DM (me + a new friend)
    const other = seedUser(t.db, { publicKey: 'pk2' });
    makeFriends(t.db, me, other);
    const dm2 = await inject('POST', '/api/conversations/dm', meCookie, {
      friendId: other,
      members: [{ userId: me, sealedKey: SEALED }, { userId: other, sealedKey: SEALED }],
    });
    const conv2 = dm2.json().id;
    expect((await inject('DELETE', `/api/conversations/${conv2}/reactions/${rid}`, meCookie)).statusCode).toBe(404);
  });
});
