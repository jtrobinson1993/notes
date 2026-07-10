// Test-only auth seam for E2E (spec/testing.md, Layer E — the env-gated
// fallback the chat/voice specs call for). Registered ONLY when
// `config.testAuth` is true, which itself requires `E2E_TEST_AUTH=1` AND a
// non-production NODE_ENV. It mints an authenticated session for a fresh (or
// named) user without the WebAuthn/PRF ceremony, so a Playwright context can
// reach cookie-authed endpoints (device enrollment → device token → the v8 SFU).
//
// SECURITY: this is a deliberate auth bypass. It must never register in
// production — the caller (app.ts) guards on config.testAuth, and this module
// additionally refuses to register under NODE_ENV=production as defence in
// depth. No MK is handled here (voice/device auth doesn't need it); a
// chat-oriented seam that also seeds a known MK can extend this later.

import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { startSession } from '../session.js';
import { newId } from '../util.js';

export function testRoutes(app: FastifyInstance, db: DB, config: Config): void {
  if (!config.testAuth || process.env.NODE_ENV === 'production') return;

  // Seed a user + start a session; returns the identity so the test can address
  // this user. The session cookie is set on the response like a real login.
  app.post('/api/test/session', async (request, reply) => {
    const body = (request.body ?? {}) as { handle?: string; displayName?: string };
    const id = newId();
    db.createUser({ id, role: 'member' }); // auto-assigns a handle
    if (typeof body.handle === 'string' && body.handle) db.setUserHandle(id, body.handle);
    startSession(db, config, reply, id);
    const user = db.getUser(id);
    return reply.send({ userId: id, handle: user?.handle ?? null });
  });
}
