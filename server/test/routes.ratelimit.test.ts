import { describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from '../../test/helpers/server.js';

async function withApp(rateLimitMax: number, fn: (t: TestApp) => Promise<void>): Promise<void> {
  const t = await makeApp({ rateLimitMax });
  try {
    await fn(t);
  } finally {
    await t.cleanup();
  }
}

describe('rate limiting', () => {
  it('caps requests globally and 429s past the per-IP ceiling', async () => {
    await withApp(4, async (t) => {
      for (let i = 0; i < 4; i++) {
        expect((await t.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
      }
      const blocked = await t.app.inject({ method: 'GET', url: '/api/health' });
      expect(blocked.statusCode).toBe(429);
    });
  });

  it('gives the auth ceremony a tighter ceiling than the global limit', async () => {
    // Global 300 → auth max = ceil(300/10) = 30. The 31st login/options is
    // throttled by the auth bucket while the global bucket (300) is nowhere near
    // full, so an unrelated route still succeeds.
    await withApp(300, async (t) => {
      for (let i = 0; i < 30; i++) {
        expect((await t.app.inject({ method: 'POST', url: '/api/login/options' })).statusCode).toBe(200);
      }
      expect((await t.app.inject({ method: 'POST', url: '/api/login/options' })).statusCode).toBe(429);
      expect((await t.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    });
  });
});
