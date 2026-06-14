import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { ServerFrame } from '@notes/shared';
import {
  TEST_ORIGIN,
  authCookie,
  makeApp,
  makeFriends,
  seedUser,
  type TestApp,
} from '../../test/helpers/server.js';

let t: TestApp;
let port: number;

beforeEach(async () => {
  t = await makeApp();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  port = (t.app.server.address() as AddressInfo).port;
});
afterEach(() => t.cleanup());

/** A test WS client that records frames and resolves promises on demand. */
class Client {
  ws: WebSocket;
  frames: ServerFrame[] = [];
  closed = false;
  private waiters: { pred: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }[] = [];

  // origin: a string sets the header, null omits it entirely (undefined would
  // trigger the default — JS default-param semantics).
  constructor(cookie?: string, origin: string | null = TEST_ORIGIN) {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    if (origin) headers.origin = origin;
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers });
    this.ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as ServerFrame;
      this.frames.push(frame);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(frame)) {
          w.resolve(frame);
          return false;
        }
        return true;
      });
    });
    this.ws.on('close', () => {
      this.closed = true;
    });
  }

  waitFor(pred: (f: ServerFrame) => boolean, ms = 2000): Promise<ServerFrame> {
    const existing = this.frames.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for frame')), ms);
      this.waiters.push({
        pred,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  }

  waitClose(ms = 2000): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for close')), ms);
      this.ws.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}

describe('upgrade authentication', () => {
  it('says hello to an authenticated connection', async () => {
    const me = seedUser(t.db);
    const c = new Client(authCookie(t.db, me));
    const hello = await c.waitFor((f) => f.type === 'hello');
    expect(hello).toEqual({ type: 'hello', userId: me });
    c.close();
  });

  it('rejects a connection with no cookie (closes, no hello)', async () => {
    const c = new Client(undefined);
    await c.waitClose();
    expect(c.frames).toHaveLength(0);
  });

  it('rejects a mismatched Origin', async () => {
    const me = seedUser(t.db);
    const c = new Client(authCookie(t.db, me), 'https://evil.example');
    await c.waitClose();
    expect(c.frames).toHaveLength(0);
  });

  it('rejects an absent Origin', async () => {
    const me = seedUser(t.db);
    const c = new Client(authCookie(t.db, me), null);
    await c.waitClose();
    expect(c.frames).toHaveLength(0);
  });
});

describe('fan-out', () => {
  it('a REST send reaches both members of a DM (including the sender)', async () => {
    const a = seedUser(t.db);
    const b = seedUser(t.db);
    makeFriends(t.db, a, b);
    t.db.createConversation({ id: 'c1', kind: 'dm', createdBy: a, dmKey: 'a:b' });
    t.db.addConversationMember({ conversationId: 'c1', userId: a, sealedKey: '{}', epoch: 0 });
    t.db.addConversationMember({ conversationId: 'c1', userId: b, sealedKey: '{}', epoch: 0 });

    const ca = new Client(authCookie(t.db, a));
    const cb = new Client(authCookie(t.db, b));
    await ca.waitFor((f) => f.type === 'hello');
    await cb.waitFor((f) => f.type === 'hello');

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/conversations/c1/messages',
      headers: { cookie: authCookie(t.db, a) },
      payload: { ciphertext: 'hello', iv: 'iv', epoch: 0 },
    });
    expect(res.statusCode).toBe(200);

    const isMsg = (f: ServerFrame) => f.type === 'message' && f.message.conversationId === 'c1';
    const fa = await ca.waitFor(isMsg);
    const fb = await cb.waitFor(isMsg);
    expect(fa.type === 'message' && fa.message.seq).toBe(1);
    expect(fb.type === 'message' && fb.message.seq).toBe(1);

    ca.close();
    cb.close();
  });

  it('read receipts fan out to the other member but not the reader', async () => {
    const a = seedUser(t.db);
    const b = seedUser(t.db);
    makeFriends(t.db, a, b);
    t.db.createConversation({ id: 'c1', kind: 'dm', createdBy: a, dmKey: 'a:b' });
    t.db.addConversationMember({ conversationId: 'c1', userId: a, sealedKey: '{}', epoch: 0 });
    t.db.addConversationMember({ conversationId: 'c1', userId: b, sealedKey: '{}', epoch: 0 });
    t.db.insertMessage({ id: 'm1', conversationId: 'c1', senderId: a, epoch: 0, ciphertext: 'x', iv: 'i' });

    const ca = new Client(authCookie(t.db, a));
    const cb = new Client(authCookie(t.db, b));
    await ca.waitFor((f) => f.type === 'hello');
    await cb.waitFor((f) => f.type === 'hello');

    await t.app.inject({
      method: 'POST',
      url: '/api/conversations/c1/read',
      headers: { cookie: authCookie(t.db, b) },
      payload: { seq: 1 },
    });

    // A (the other member) gets the read receipt for B.
    const read = await ca.waitFor((f) => f.type === 'read');
    expect(read).toEqual({ type: 'read', conversationId: 'c1', userId: b, seq: 1 });
    // B (the reader) is excluded — it never sees its own read frame.
    expect(cb.frames.some((f) => f.type === 'read')).toBe(false);

    ca.close();
    cb.close();
  });
});

describe('presence', () => {
  it('notifies an online friend on connect and disconnect', async () => {
    const a = seedUser(t.db);
    const b = seedUser(t.db);
    makeFriends(t.db, a, b);

    const ca = new Client(authCookie(t.db, a));
    await ca.waitFor((f) => f.type === 'hello');

    // B comes online → A is told.
    const cb = new Client(authCookie(t.db, b));
    await cb.waitFor((f) => f.type === 'hello');
    const online = await ca.waitFor((f) => f.type === 'presence' && f.userId === b && f.online === true);
    expect(online.type).toBe('presence');

    // B goes offline → A is told.
    cb.close();
    const offline = await ca.waitFor((f) => f.type === 'presence' && f.userId === b && f.online === false);
    expect(offline.type).toBe('presence');

    ca.close();
  });
});

describe('per-user socket cap', () => {
  it('evicts the oldest socket once the cap (8) is exceeded', async () => {
    const me = seedUser(t.db);
    const cookie = authCookie(t.db, me);
    const clients: Client[] = [];
    for (let i = 0; i < 8; i++) {
      const c = new Client(cookie);
      await c.waitFor((f) => f.type === 'hello');
      clients.push(c);
    }
    // The 9th connection pushes the oldest out.
    const ninth = new Client(cookie);
    await ninth.waitFor((f) => f.type === 'hello');
    await clients[0]!.waitClose();
    expect(clients[0]!.closed).toBe(true);

    for (const c of clients.slice(1)) c.close();
    ninth.close();
  });
});
