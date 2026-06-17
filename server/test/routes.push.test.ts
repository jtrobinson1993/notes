import { describe, it, expect, afterEach } from 'vitest';
import { makeApp, seedAuthedUser, type TestApp } from '../../test/helpers/server.js';

let ctx: TestApp;
afterEach(async () => ctx && ctx.cleanup());

const SUB = { endpoint: 'https://push.example.com/sub/abc', keys: { p256dh: 'BPxyz', auth: 'TOKEN' } };

describe('push routes', () => {
  it('returns a VAPID public key', async () => {
    ctx = await makeApp();
    const { cookie } = seedAuthedUser(ctx.db);
    const res = await ctx.app.inject({ method: 'GET', url: '/api/push/key', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().publicKey).toBe('string');
    expect(res.json().publicKey.length).toBeGreaterThan(20);
  });

  it('requires auth', async () => {
    ctx = await makeApp();
    const res = await ctx.app.inject({ method: 'GET', url: '/api/push/key' });
    expect(res.statusCode).toBe(401);
  });

  it('stores a valid subscription and removes it on unsubscribe', async () => {
    ctx = await makeApp();
    const { id, cookie } = seedAuthedUser(ctx.db);

    const sub = await ctx.app.inject({ method: 'POST', url: '/api/push/subscribe', headers: { cookie }, payload: SUB });
    expect(sub.statusCode).toBe(200);
    expect(ctx.db.listPushSubscriptions(id)).toHaveLength(1);

    const un = await ctx.app.inject({
      method: 'POST',
      url: '/api/push/unsubscribe',
      headers: { cookie },
      payload: { endpoint: SUB.endpoint },
    });
    expect(un.statusCode).toBe(200);
    expect(ctx.db.listPushSubscriptions(id)).toHaveLength(0);
  });

  it('rejects a non-https endpoint and a malformed payload', async () => {
    ctx = await makeApp();
    const { cookie } = seedAuthedUser(ctx.db);
    const bad1 = await ctx.app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: { cookie },
      payload: { endpoint: 'http://insecure/sub', keys: { p256dh: 'p', auth: 'a' } },
    });
    expect(bad1.statusCode).toBe(400);
    const bad2 = await ctx.app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: { cookie },
      payload: { endpoint: 'https://ok/sub' },
    });
    expect(bad2.statusCode).toBe(400);
  });

  it('upserts the same endpoint instead of duplicating it', async () => {
    ctx = await makeApp();
    const { id, cookie } = seedAuthedUser(ctx.db);
    await ctx.app.inject({ method: 'POST', url: '/api/push/subscribe', headers: { cookie }, payload: SUB });
    await ctx.app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: { cookie },
      payload: { ...SUB, keys: { p256dh: 'NEW', auth: 'NEW' } },
    });
    const subs = ctx.db.listPushSubscriptions(id);
    expect(subs).toHaveLength(1);
    expect(subs[0]!.p256dh).toBe('NEW');
  });
});
