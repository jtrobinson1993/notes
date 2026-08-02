import { describe, expect, it } from 'vitest';
import { makeRelayApp, type TestApp } from '../../test/helpers/server.js';

// The relay registers @fastify/rate-limit globally. The content proxies' own
// buckets are asserted in routes.relayContent.test.ts; this file covers the
// global per-IP ceiling and the tighter bucket on a brute-forceable route.

async function withApp(rateLimitMax: number, fn: (t: TestApp) => Promise<void>): Promise<void> {
  const t = await makeRelayApp({ rateLimitMax });
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

  it('gives the invite oracle a far tighter ceiling than the global limit', async () => {
    // `invites/check` is unauthenticated and answers yes/no about a token, so it
    // carries its own 30/min bucket. The 31st attempt is throttled while the
    // global bucket (300) is nowhere near full, so an unrelated route still 200s.
    const attempt = (t: TestApp) =>
      t.app.inject({ method: 'POST', url: '/api/relay/invites/check', payload: { token: 'nope' } });

    await withApp(300, async (t) => {
      for (let i = 0; i < 30; i++) {
        // Answered (200, `valid: false`) but not throttled — the bucket is what's under test.
        expect((await attempt(t)).statusCode).toBe(200);
      }
      expect((await attempt(t)).statusCode).toBe(429);
      expect((await t.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    });
  });
});
