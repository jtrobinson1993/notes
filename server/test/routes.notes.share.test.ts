import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authCookie, makeApp, makeFriends, seedUser, type TestApp } from '../../test/helpers/server.js';

const SEALED = { epk: 'AAAA', iv: 'BBBB', ct: 'CCCC' };
const WK = { salt: 's', iv: 'i', ct: 'c' };

let t: TestApp;
let me: string;
let friend: string;
let stranger: string;
let meCookie: string;

function inject(method: string, url: string, cookie?: string, payload?: unknown) {
  return t.app.inject({ method: method as 'GET', url, headers: cookie ? { cookie } : {}, payload: payload as object });
}

beforeEach(async () => {
  t = await makeApp();
  me = seedUser(t.db, { username: 'me', displayName: 'Me', publicKey: 'pk-me' });
  friend = seedUser(t.db, { username: 'frienduser', displayName: 'Buddy', publicKey: 'pk-fr' });
  stranger = seedUser(t.db, { username: 'stranger', displayName: 'Stranger', publicKey: 'pk-st' });
  makeFriends(t.db, me, friend);
  meCookie = authCookie(t.db, me);
  t.db.upsertNote({ id: 'n1', userId: me, ciphertext: 'ct', iv: 'iv', wrappedKey: WK, createdAt: 1 });
});
afterEach(() => t.cleanup());

const share = (recipientId: string, cookie = meCookie) =>
  inject('POST', '/api/notes/n1/shares', cookie, { recipientId, sealedKey: SEALED, access: 'read' });

describe('GET /api/members', () => {
  it('lists only the caller\'s friends, by display name (never username)', async () => {
    const members = (await inject('GET', '/api/members', meCookie)).json() as { id: string; displayName: string }[];
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ id: friend, displayName: 'Buddy' });
    expect(JSON.stringify(members)).not.toContain('frienduser'); // no username leak
  });
});

describe('POST /api/notes/:id/shares (friends-gated)', () => {
  it('shares with a friend', async () => {
    expect((await share(friend)).statusCode).toBe(200);
    const shares = (await inject('GET', '/api/notes/n1/shares', meCookie)).json() as { recipientDisplayName: string }[];
    expect(shares[0]).toMatchObject({ recipientId: friend, recipientDisplayName: 'Buddy' });
  });

  it('refuses to share with a non-friend', async () => {
    expect((await share(stranger)).statusCode).toBe(403);
  });

  it('refuses to share with yourself', async () => {
    expect((await share(me)).statusCode).toBe(400);
  });
});

describe('GET /api/shared', () => {
  it('shows the owner by display name, not username', async () => {
    await share(friend);
    const shared = (await inject('GET', '/api/shared', authCookie(t.db, friend))).json() as { ownerDisplayName: string }[];
    expect(shared[0]).toMatchObject({ id: 'n1', ownerDisplayName: 'Me' });
    expect(JSON.stringify(shared)).not.toContain('"me"'); // owner username not exposed
  });
});
