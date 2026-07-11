import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildRelayApp } from '../src/relay-app.js';
import { makeConfig, makeDb, type TestDb } from '../../test/helpers/server.js';

let app: FastifyInstance | null = null;
let dbCtx: TestDb | null = null;
afterEach(async () => {
  if (app) await app.close();
  if (dbCtx) dbCtx.cleanup();
  app = null;
  dbCtx = null;
});

async function makeRelay(mode: 'public' | 'invite' = 'public'): Promise<FastifyInstance> {
  dbCtx = makeDb();
  const config = makeConfig(dbCtx.dir, { registrationMode: mode });
  app = await buildRelayApp(dbCtx.db, config);
  app.log.level = 'silent';
  await app.ready();
  return app;
}

function pubKey(): string {
  const spki = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return spki.subarray(spki.length - 32).toString('base64');
}

describe('standalone relay app', () => {
  it('serves the health probe and relay info', async () => {
    const a = await makeRelay();
    expect((await a.inject({ method: 'GET', url: '/api/health' })).json()).toEqual({ ok: true });
    const info = await a.inject({ method: 'GET', url: '/api/relay/info' });
    expect(info.statusCode).toBe(200);
    expect(info.json().registrationMode).toBe('public');
  });

  it('handles registration (the relay surface is fully wired)', async () => {
    const a = await makeRelay('public');
    const res = await a.inject({
      method: 'POST',
      url: '/api/relay/register',
      payload: { pubKey: pubKey() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().handle).toMatch(/#\d{4}$/);
  });

  it('does NOT mount the legacy web-app stack', async () => {
    const a = await makeRelay();
    // Legacy auth / notes / friends / admin routes are absent → 404, not served.
    for (const url of ['/api/meta', '/api/me', '/api/notes', '/api/friends', '/api/invites']) {
      expect((await a.inject({ method: 'GET', url })).statusCode).toBe(404);
    }
    // No SPA fallback either: an unknown GET is a JSON 404, not index.html.
    const spa = await a.inject({ method: 'GET', url: '/some/app/route' });
    expect(spa.statusCode).toBe(404);
    expect(spa.headers['content-type']).toContain('application/json');
  });

  it('has no legacy session layer — the vestigial device endpoints 401', async () => {
    const a = await makeRelay();
    // requireAuth with no session hooks → 401 (not a crash, not 200).
    const res = await a.inject({ method: 'GET', url: '/api/relay/devices' });
    expect(res.statusCode).toBe(401);
  });
});
