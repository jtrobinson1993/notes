import { afterEach, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from '../../test/helpers/server.js';

let ctx: TestApp;
afterEach(async () => ctx && ctx.cleanup());

describe('test-auth seam (E2E only)', () => {
  it('is NOT registered by default (404) — no accidental auth bypass', async () => {
    ctx = await makeApp(); // testAuth defaults to false
    const res = await ctx.app.inject({ method: 'POST', url: '/api/test/session', payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it('mints an authenticated session when testAuth is on', async () => {
    ctx = await makeApp({ testAuth: true });
    const res = await ctx.app.inject({ method: 'POST', url: '/api/test/session', payload: { handle: 'Tester#0001' } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { userId: string; handle: string };
    expect(body.userId).toBeTruthy();
    expect(body.handle).toBe('Tester#0001');

    // The Set-Cookie session authenticates a follow-up request (device enroll).
    const cookie = res.cookies.find((c) => c.name === 'notes_session');
    expect(cookie?.value).toBeTruthy();
    const enroll = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/devices',
      headers: { cookie: `notes_session=${cookie!.value}` },
      payload: { pubKey: Buffer.alloc(32, 7).toString('base64') },
    });
    expect(enroll.statusCode).toBe(200);
  });

  it('refuses to register under NODE_ENV=production even if flagged on', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      ctx = await makeApp({ testAuth: true });
      const res = await ctx.app.inject({ method: 'POST', url: '/api/test/session', payload: {} });
      expect(res.statusCode).toBe(404);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
