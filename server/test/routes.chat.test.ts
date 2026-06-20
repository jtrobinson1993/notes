import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authCookie,
  makeApp,
  makeFriends,
  seedUser,
  type TestApp,
} from '../../test/helpers/server.js';

const SEALED = { epk: 'AAAA', iv: 'BBBB', ct: 'CCCC' };

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(() => t.cleanup());

function inject(opts: { method: any; url: string; cookie?: string; payload?: unknown }) {
  return t.app.inject({
    method: opts.method,
    url: opts.url,
    headers: opts.cookie ? { cookie: opts.cookie } : {},
    payload: opts.payload as object | undefined,
  });
}

// ----------------------------------------------------------------- auth seam

describe('auth — every chat route rejects the unauthenticated', () => {
  const routes: [string, string][] = [
    ['POST', '/api/friend-invites'],
    ['GET', '/api/friend-invites'],
    ['DELETE', '/api/friend-invites/x'],
    ['POST', '/api/friends/redeem'],
    ['GET', '/api/friends/requests'],
    ['POST', '/api/friends/requests/x/accept'],
    ['POST', '/api/friends/requests/x/decline'],
    ['GET', '/api/friends'],
    ['DELETE', '/api/friends/x'],
    ['GET', '/api/profile'],
    ['PUT', '/api/profile'],
    ['GET', '/api/profile/data'],
    ['PUT', '/api/profile/data'],
    ['POST', '/api/profile/keys'],
    ['PUT', '/api/profile/visibility'],
    ['PUT', '/api/profile/link-previews'],
    ['GET', '/api/og'],
    ['GET', '/api/users/x/profile'],
    ['GET', '/api/conversations'],
    ['POST', '/api/conversations/dm'],
    ['POST', '/api/conversations/group'],
    ['GET', '/api/conversations/x/messages'],
    ['POST', '/api/conversations/x/messages'],
    ['POST', '/api/conversations/x/read'],
  ];

  it.each(routes)('%s %s → 401', async (method, url) => {
    const res = await inject({ method, url, payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a seeded session cookie (the auth seam works)', async () => {
    const me = seedUser(t.db, { displayName: 'Me' });
    const res = await inject({ method: 'GET', url: '/api/profile', cookie: authCookie(t.db, me) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ displayName: 'Me', handle: expect.any(String), nameColor: null, friendsOnly: true, linkPreviews: false });
  });

  it('rejects a cross-origin mutating request (CSRF guard)', async () => {
    const me = seedUser(t.db);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/friend-invites',
      headers: { cookie: authCookie(t.db, me), origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ------------------------------------------------------------------- friends

describe('friends — redeem rules', () => {
  it('redeem creates an incoming request; rejects own / duplicate / unknown', async () => {
    const owner = seedUser(t.db, { displayName: 'Owner' });
    const joiner = seedUser(t.db, { displayName: 'Joiner' });
    const ownerCookie = authCookie(t.db, owner);
    const joinerCookie = authCookie(t.db, joiner);

    const made = await inject({ method: 'POST', url: '/api/friend-invites', cookie: ownerCookie });
    const token = made.json().token as string;

    // Owner cannot redeem their own invite.
    const own = await inject({ method: 'POST', url: '/api/friends/redeem', cookie: ownerCookie, payload: { token } });
    expect(own.statusCode).toBe(400);

    // Unknown token → 404.
    const unknown = await inject({ method: 'POST', url: '/api/friends/redeem', cookie: joinerCookie, payload: { token: 'nope' } });
    expect(unknown.statusCode).toBe(404);

    // Joiner redeems → request appears for owner.
    const ok = await inject({ method: 'POST', url: '/api/friends/redeem', cookie: joinerCookie, payload: { token } });
    expect(ok.statusCode).toBe(200);

    // Duplicate request → 409.
    const dup = await inject({ method: 'POST', url: '/api/friends/redeem', cookie: joinerCookie, payload: { token } });
    expect(dup.statusCode).toBe(409);
  });

  it('rejects an expired invite (404)', async () => {
    const owner = seedUser(t.db);
    const joiner = seedUser(t.db);
    t.db.createFriendInvite({ id: 'inv', token: 'expired', createdBy: owner, expiresAt: Date.now() - 1 });
    const res = await inject({ method: 'POST', url: '/api/friends/redeem', cookie: authCookie(t.db, joiner), payload: { token: 'expired' } });
    expect(res.statusCode).toBe(404);
  });
});

describe('friends — accept / decline authorization', () => {
  async function pendingRequest(): Promise<{ owner: string; joiner: string; reqId: string }> {
    const owner = seedUser(t.db, { displayName: 'Owner' });
    const joiner = seedUser(t.db, { displayName: 'Joiner' });
    const made = await inject({ method: 'POST', url: '/api/friend-invites', cookie: authCookie(t.db, owner) });
    const token = made.json().token as string;
    await inject({ method: 'POST', url: '/api/friends/redeem', cookie: authCookie(t.db, joiner), payload: { token } });
    const reqId = t.db.listFriendRequests(owner)[0]!.id;
    return { owner, joiner, reqId };
  }

  it('only the recipient (owner) can accept; friendship becomes two-way', async () => {
    const { owner, joiner, reqId } = await pendingRequest();

    // The sender cannot accept their own outgoing request.
    const wrong = await inject({ method: 'POST', url: `/api/friends/requests/${reqId}/accept`, cookie: authCookie(t.db, joiner) });
    expect(wrong.statusCode).toBe(404);

    const ok = await inject({ method: 'POST', url: `/api/friends/requests/${reqId}/accept`, cookie: authCookie(t.db, owner) });
    expect(ok.statusCode).toBe(200);
    expect(t.db.areFriends(owner, joiner)).toBe(true);
    expect(t.db.areFriends(joiner, owner)).toBe(true);
  });

  it('either party can decline', async () => {
    const { joiner, reqId } = await pendingRequest();
    const res = await inject({ method: 'POST', url: `/api/friends/requests/${reqId}/decline`, cookie: authCookie(t.db, joiner) });
    expect(res.statusCode).toBe(200);
    expect(t.db.getFriendRequest(reqId)).toBeUndefined();
  });

  it('a stranger cannot decline', async () => {
    const { reqId } = await pendingRequest();
    const stranger = seedUser(t.db);
    const res = await inject({ method: 'POST', url: `/api/friends/requests/${reqId}/decline`, cookie: authCookie(t.db, stranger) });
    expect(res.statusCode).toBe(404);
  });
});

describe('friend-invite deletion is scoped to the owner', () => {
  it('a non-owner gets 404 and the invite survives', async () => {
    const owner = seedUser(t.db);
    const other = seedUser(t.db);
    const made = await inject({ method: 'POST', url: '/api/friend-invites', cookie: authCookie(t.db, owner) });
    const id = made.json().id as string;

    const forbidden = await inject({ method: 'DELETE', url: `/api/friend-invites/${id}`, cookie: authCookie(t.db, other) });
    expect(forbidden.statusCode).toBe(404);
    expect(t.db.getFriendInvite(id)).toBeDefined();

    const ok = await inject({ method: 'DELETE', url: `/api/friend-invites/${id}`, cookie: authCookie(t.db, owner) });
    expect(ok.statusCode).toBe(200);
    expect(t.db.getFriendInvite(id)).toBeUndefined();
  });
});

// ------------------------------------------------------------------------ DM

describe('DM conversations', () => {
  function dmPayload(me: string, friend: string) {
    return {
      friendId: friend,
      members: [
        { userId: me, sealedKey: SEALED },
        { userId: friend, sealedKey: SEALED },
      ],
    };
  }

  it('is idempotent on dm_key — a second create returns the same conversation', async () => {
    const me = seedUser(t.db, { publicKey: 'pkme' });
    const friend = seedUser(t.db, { publicKey: 'pkfr' });
    makeFriends(t.db, me, friend);
    const cookie = authCookie(t.db, me);

    const first = await inject({ method: 'POST', url: '/api/conversations/dm', cookie, payload: dmPayload(me, friend) });
    expect(first.statusCode).toBe(200);
    const id = first.json().id as string;

    const second = await inject({ method: 'POST', url: '/api/conversations/dm', cookie, payload: dmPayload(me, friend) });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(id);
    expect(t.db.raw.prepare('SELECT COUNT(*) AS c FROM conversations').get()).toMatchObject({ c: 1 });
  });

  it('requires an existing friendship', async () => {
    const me = seedUser(t.db);
    const stranger = seedUser(t.db);
    const res = await inject({ method: 'POST', url: '/api/conversations/dm', cookie: authCookie(t.db, me), payload: dmPayload(me, stranger) });
    expect(res.statusCode).toBe(400);
  });

  it('rejects member sets that are not exactly {me, friend}', async () => {
    const me = seedUser(t.db);
    const friend = seedUser(t.db);
    const third = seedUser(t.db);
    makeFriends(t.db, me, friend);
    const cookie = authCookie(t.db, me);

    const missing = await inject({
      method: 'POST',
      url: '/api/conversations/dm',
      cookie,
      payload: { friendId: friend, members: [{ userId: me, sealedKey: SEALED }] },
    });
    expect(missing.statusCode).toBe(400);

    const extra = await inject({
      method: 'POST',
      url: '/api/conversations/dm',
      cookie,
      payload: {
        friendId: friend,
        members: [
          { userId: me, sealedKey: SEALED },
          { userId: friend, sealedKey: SEALED },
          { userId: third, sealedKey: SEALED },
        ],
      },
    });
    expect(extra.statusCode).toBe(400);
  });

  it('returns my own sealed key copy in the conversation', async () => {
    const me = seedUser(t.db);
    const friend = seedUser(t.db);
    makeFriends(t.db, me, friend);
    const res = await inject({ method: 'POST', url: '/api/conversations/dm', cookie: authCookie(t.db, me), payload: dmPayload(me, friend) });
    expect(res.json().sealedKey).toEqual(SEALED);
    expect(res.json().members).toHaveLength(2);
  });
});

describe('Group conversations', () => {
  function groupPayload(...userIds: string[]) {
    return { members: userIds.map((userId) => ({ userId, sealedKey: SEALED })) };
  }

  it('creates a group of me + two friends', async () => {
    const me = seedUser(t.db);
    const a = seedUser(t.db);
    const b = seedUser(t.db);
    makeFriends(t.db, me, a);
    makeFriends(t.db, me, b);
    const res = await inject({
      method: 'POST',
      url: '/api/conversations/group',
      cookie: authCookie(t.db, me),
      payload: groupPayload(me, a, b),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe('group');
    expect(res.json().members).toHaveLength(3);
    expect(res.json().sealedKey).toEqual(SEALED);
  });

  it('is not idempotent — each call makes a distinct group', async () => {
    const me = seedUser(t.db);
    const a = seedUser(t.db);
    const b = seedUser(t.db);
    makeFriends(t.db, me, a);
    makeFriends(t.db, me, b);
    const cookie = authCookie(t.db, me);
    const first = await inject({ method: 'POST', url: '/api/conversations/group', cookie, payload: groupPayload(me, a, b) });
    const second = await inject({ method: 'POST', url: '/api/conversations/group', cookie, payload: groupPayload(me, a, b) });
    expect(first.json().id).not.toBe(second.json().id);
  });

  it('rejects fewer than three members', async () => {
    const me = seedUser(t.db);
    const a = seedUser(t.db);
    makeFriends(t.db, me, a);
    const res = await inject({
      method: 'POST',
      url: '/api/conversations/group',
      cookie: authCookie(t.db, me),
      payload: groupPayload(me, a),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a group that includes a non-friend', async () => {
    const me = seedUser(t.db);
    const friend = seedUser(t.db);
    const stranger = seedUser(t.db);
    makeFriends(t.db, me, friend);
    const res = await inject({
      method: 'POST',
      url: '/api/conversations/group',
      cookie: authCookie(t.db, me),
      payload: groupPayload(me, friend, stranger),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a member set that omits the creator', async () => {
    const me = seedUser(t.db);
    const a = seedUser(t.db);
    const b = seedUser(t.db);
    makeFriends(t.db, me, a);
    makeFriends(t.db, me, b);
    const res = await inject({
      method: 'POST',
      url: '/api/conversations/group',
      cookie: authCookie(t.db, me),
      payload: groupPayload(a, b, seedUser(t.db)),
    });
    expect(res.statusCode).toBe(400);
  });
});

// --------------------------------------------------------------- IDOR + revoke

describe('IDOR — a non-member is forbidden, and unfriend revokes a member', () => {
  async function makeDm(): Promise<{ me: string; friend: string; convId: string }> {
    const me = seedUser(t.db);
    const friend = seedUser(t.db);
    makeFriends(t.db, me, friend);
    const res = await inject({
      method: 'POST',
      url: '/api/conversations/dm',
      cookie: authCookie(t.db, me),
      payload: {
        friendId: friend,
        members: [
          { userId: me, sealedKey: SEALED },
          { userId: friend, sealedKey: SEALED },
        ],
      },
    });
    return { me, friend, convId: res.json().id as string };
  }

  it('a non-member gets 403 on history / send / read', async () => {
    const { convId } = await makeDm();
    const outsider = authCookie(t.db, seedUser(t.db));
    const history = await inject({ method: 'GET', url: `/api/conversations/${convId}/messages`, cookie: outsider });
    expect(history.statusCode).toBe(403);
    const send = await inject({ method: 'POST', url: `/api/conversations/${convId}/messages`, cookie: outsider, payload: { ciphertext: 'x', iv: 'i', epoch: 0 } });
    expect(send.statusCode).toBe(403);
    const read = await inject({ method: 'POST', url: `/api/conversations/${convId}/read`, cookie: outsider, payload: { seq: 1 } });
    expect(read.statusCode).toBe(403);
  });

  it('unfriend revokes DM access and drops it from GET /conversations', async () => {
    const { me, friend, convId } = await makeDm();
    const meCookie = authCookie(t.db, me);

    expect((await inject({ method: 'GET', url: '/api/conversations', cookie: meCookie })).json()).toHaveLength(1);

    const del = await inject({ method: 'DELETE', url: `/api/friends/${friend}`, cookie: meCookie });
    expect(del.statusCode).toBe(200);

    const history = await inject({ method: 'GET', url: `/api/conversations/${convId}/messages`, cookie: meCookie });
    expect(history.statusCode).toBe(403);
    expect((await inject({ method: 'GET', url: '/api/conversations', cookie: meCookie })).json()).toHaveLength(0);
  });
});

// ------------------------------------------------------------------- messages

describe('messages — send / backfill / read', () => {
  async function makeDm(): Promise<{ me: string; friend: string; convId: string }> {
    const me = seedUser(t.db);
    const friend = seedUser(t.db);
    makeFriends(t.db, me, friend);
    const res = await inject({
      method: 'POST',
      url: '/api/conversations/dm',
      cookie: authCookie(t.db, me),
      payload: {
        friendId: friend,
        members: [
          { userId: me, sealedKey: SEALED },
          { userId: friend, sealedKey: SEALED },
        ],
      },
    });
    return { me, friend, convId: res.json().id as string };
  }

  it('send assigns the next seq', async () => {
    const { me, convId } = await makeDm();
    const cookie = authCookie(t.db, me);
    const first = await inject({ method: 'POST', url: `/api/conversations/${convId}/messages`, cookie, payload: { ciphertext: 'a', iv: 'i', epoch: 0 } });
    const second = await inject({ method: 'POST', url: `/api/conversations/${convId}/messages`, cookie, payload: { ciphertext: 'b', iv: 'i', epoch: 0 } });
    expect(first.json().seq).toBe(1);
    expect(second.json().seq).toBe(2);
  });

  it('rejects an invalid payload (400)', async () => {
    const { me, convId } = await makeDm();
    const res = await inject({ method: 'POST', url: `/api/conversations/${convId}/messages`, cookie: authCookie(t.db, me), payload: { ciphertext: '', iv: 'i', epoch: 0 } });
    expect(res.statusCode).toBe(400);
  });

  it('backfills DESC and paginates with before', async () => {
    const { me, convId } = await makeDm();
    const cookie = authCookie(t.db, me);
    for (let i = 0; i < 5; i++) {
      await inject({ method: 'POST', url: `/api/conversations/${convId}/messages`, cookie, payload: { ciphertext: `m${i}`, iv: 'i', epoch: 0 } });
    }
    const head = await inject({ method: 'GET', url: `/api/conversations/${convId}/messages?limit=2`, cookie });
    expect(head.json().map((m: any) => m.seq)).toEqual([5, 4]);
    const older = await inject({ method: 'GET', url: `/api/conversations/${convId}/messages?before=4&limit=2`, cookie });
    expect(older.json().map((m: any) => m.seq)).toEqual([3, 2]);
  });

  it('read marker advances (never backward)', async () => {
    const { me, convId } = await makeDm();
    const cookie = authCookie(t.db, me);
    for (let i = 0; i < 3; i++) {
      await inject({ method: 'POST', url: `/api/conversations/${convId}/messages`, cookie, payload: { ciphertext: `m${i}`, iv: 'i', epoch: 0 } });
    }
    await inject({ method: 'POST', url: `/api/conversations/${convId}/read`, cookie, payload: { seq: 3 } });
    expect(t.db.getConversationMember(convId, me)!.last_read_seq).toBe(3);
    await inject({ method: 'POST', url: `/api/conversations/${convId}/read`, cookie, payload: { seq: 1 } });
    expect(t.db.getConversationMember(convId, me)!.last_read_seq).toBe(3);
  });
});

// ------------------------------------------------------------------- profile

describe('profile', () => {
  it('rejects a too-long display name', async () => {
    const me = seedUser(t.db);
    const res = await inject({ method: 'PUT', url: '/api/profile', cookie: authCookie(t.db, me), payload: { displayName: 'x'.repeat(51) } });
    expect(res.statusCode).toBe(400);
  });

  it('updates a valid display name', async () => {
    const me = seedUser(t.db);
    const res = await inject({ method: 'PUT', url: '/api/profile', cookie: authCookie(t.db, me), payload: { displayName: '  Alice  ' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ displayName: 'Alice', handle: expect.any(String), nameColor: null, friendsOnly: true, linkPreviews: false });
  });

  it('sets and validates the name color', async () => {
    const me = seedUser(t.db);
    const cookie = authCookie(t.db, me);
    const ok = await inject({ method: 'PUT', url: '/api/profile', cookie, payload: { nameColor: 'blue' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().nameColor).toBe('blue');
    // rejects a color outside the palette
    expect((await inject({ method: 'PUT', url: '/api/profile', cookie, payload: { nameColor: '#ff0000' } })).statusCode).toBe(400);
    // null clears it
    expect((await inject({ method: 'PUT', url: '/api/profile', cookie, payload: { nameColor: null } })).json().nameColor).toBeNull();
  });
});

describe('E2EE profiles (bio + avatar)', () => {
  const WRAPPED = { salt: 'AAAA', iv: 'BBBB', ct: 'CCCC' };

  function dataPayload(recipients: string[], epoch = 0) {
    return {
      ciphertext: 'CT',
      iv: 'IV',
      epoch,
      ownerWrappedKey: WRAPPED,
      keys: recipients.map((recipientId) => ({ recipientId, sealedKey: SEALED })),
    };
  }

  // Make two users co-members of a group without making them friends.
  function shareGroup(...userIds: string[]): void {
    const convId = `g-${userIds.join('-')}`;
    t.db.createConversation({ id: convId, kind: 'group', createdBy: userIds[0]!, dmKey: null });
    for (const userId of userIds) {
      t.db.addConversationMember({ conversationId: convId, userId, sealedKey: JSON.stringify(SEALED), epoch: 0 });
    }
  }

  function put(url: string, cookie: string, payload: unknown) {
    return inject({ method: 'PUT', url, cookie, payload });
  }

  it('stores the blob + a friend can fetch the encrypted form with their sealed key', async () => {
    const me = seedUser(t.db, { publicKey: 'pkme' });
    const friend = seedUser(t.db, { publicKey: 'pkf' });
    makeFriends(t.db, me, friend);

    const res = await put('/api/profile/data', authCookie(t.db, me), dataPayload([friend]));
    expect(res.statusCode).toBe(200);

    const view = await inject({ method: 'GET', url: `/api/users/${me}/profile`, cookie: authCookie(t.db, friend) });
    expect(view.statusCode).toBe(200);
    expect(view.json().encrypted).toMatchObject({ ciphertext: 'CT', iv: 'IV', epoch: 0, sealedKey: SEALED });
  });

  it('returns encrypted:null to a related user who has no sealed key', async () => {
    const me = seedUser(t.db);
    const friend = seedUser(t.db);
    makeFriends(t.db, me, friend);
    await put('/api/profile/data', authCookie(t.db, me), dataPayload([])); // no recipients
    const view = await inject({ method: 'GET', url: `/api/users/${me}/profile`, cookie: authCookie(t.db, friend) });
    expect(view.json().encrypted).toBeNull();
  });

  it('GET /api/profile/data returns the owner’s own blob + wrapped key (null when unset)', async () => {
    const me = seedUser(t.db);
    const cookie = authCookie(t.db, me);
    expect((await inject({ method: 'GET', url: '/api/profile/data', cookie })).json()).toEqual({ profile: null });

    await put('/api/profile/data', cookie, dataPayload([]));
    const got = (await inject({ method: 'GET', url: '/api/profile/data', cookie })).json();
    expect(got.profile).toMatchObject({ ciphertext: 'CT', iv: 'IV', epoch: 0, ownerWrappedKey: WRAPPED });
  });

  it('rejects a sealed key for a non-friend when friends-only (the default)', async () => {
    const me = seedUser(t.db);
    const stranger = seedUser(t.db);
    const res = await put('/api/profile/data', authCookie(t.db, me), dataPayload([stranger]));
    expect(res.statusCode).toBe(400);
  });

  it('403 to GET a profile with no relationship', async () => {
    const me = seedUser(t.db);
    const stranger = seedUser(t.db);
    const view = await inject({ method: 'GET', url: `/api/users/${me}/profile`, cookie: authCookie(t.db, stranger) });
    expect(view.statusCode).toBe(403);
  });

  it('with visibility off, a group co-member may receive the key; tightening revokes it', async () => {
    const me = seedUser(t.db);
    const coMember = seedUser(t.db);
    shareGroup(me, coMember); // co-members, not friends
    const cookie = authCookie(t.db, me);

    // Off → co-member allowed.
    expect((await put('/api/profile/visibility', cookie, { friendsOnly: false })).json().friendsOnly).toBe(false);
    expect((await put('/api/profile/data', cookie, dataPayload([coMember]))).statusCode).toBe(200);
    let view = await inject({ method: 'GET', url: `/api/users/${me}/profile`, cookie: authCookie(t.db, coMember) });
    expect(view.json().encrypted).not.toBeNull();

    // Tighten to friends-only → the co-member's key is revoked.
    expect((await put('/api/profile/visibility', cookie, { friendsOnly: true })).json().friendsOnly).toBe(true);
    view = await inject({ method: 'GET', url: `/api/users/${me}/profile`, cookie: authCookie(t.db, coMember) });
    expect(view.json().encrypted).toBeNull();
  });

  it('unfriending revokes profile access in both directions', async () => {
    const me = seedUser(t.db);
    const friend = seedUser(t.db);
    makeFriends(t.db, me, friend);
    await put('/api/profile/data', authCookie(t.db, me), dataPayload([friend]));

    expect(
      (await inject({ method: 'GET', url: `/api/users/${me}/profile`, cookie: authCookie(t.db, friend) })).json().encrypted,
    ).not.toBeNull();

    await inject({ method: 'DELETE', url: `/api/friends/${friend}`, cookie: authCookie(t.db, me) });
    // No relationship now → 403 (and the key row is gone).
    expect(
      (await inject({ method: 'GET', url: `/api/users/${me}/profile`, cookie: authCookie(t.db, friend) })).statusCode,
    ).toBe(403);
    expect(t.db.getProfileKeyFor(me, friend)).toBeUndefined();
  });

  it('POST /api/profile/keys distributes to a new friend at the matching epoch', async () => {
    const me = seedUser(t.db);
    const friend = seedUser(t.db);
    makeFriends(t.db, me, friend);
    const cookie = authCookie(t.db, me);
    await put('/api/profile/data', cookie, dataPayload([])); // profile exists at epoch 0, no keys

    const add = await inject({
      method: 'POST',
      url: '/api/profile/keys',
      cookie,
      payload: { epoch: 0, keys: [{ recipientId: friend, sealedKey: SEALED }] },
    });
    expect(add.statusCode).toBe(200);
    const view = await inject({ method: 'GET', url: `/api/users/${me}/profile`, cookie: authCookie(t.db, friend) });
    expect(view.json().encrypted).not.toBeNull();

    // Epoch mismatch is rejected.
    const stale = await inject({
      method: 'POST',
      url: '/api/profile/keys',
      cookie,
      payload: { epoch: 9, keys: [{ recipientId: friend, sealedKey: SEALED }] },
    });
    expect(stale.statusCode).toBe(409);
  });

  it('POST /api/profile/keys 404s when no profile is set', async () => {
    const me = seedUser(t.db);
    const friend = seedUser(t.db);
    makeFriends(t.db, me, friend);
    const res = await inject({
      method: 'POST',
      url: '/api/profile/keys',
      cookie: authCookie(t.db, me),
      payload: { epoch: 0, keys: [{ recipientId: friend, sealedKey: SEALED }] },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rotation: a new epoch replaces the old sealed keys', async () => {
    const me = seedUser(t.db);
    const a = seedUser(t.db);
    const b = seedUser(t.db);
    makeFriends(t.db, me, a);
    makeFriends(t.db, me, b);
    const cookie = authCookie(t.db, me);
    await put('/api/profile/data', cookie, dataPayload([a, b], 0));
    expect(t.db.getProfileKeyFor(me, a)).toBeDefined();

    // Rotate to epoch 1, re-sealing only to b (a was removed).
    await put('/api/profile/data', cookie, dataPayload([b], 1));
    expect(t.db.getProfileKeyFor(me, a)).toBeUndefined();
    expect(t.db.getProfileKeyFor(me, b)?.epoch).toBe(1);
  });
});
