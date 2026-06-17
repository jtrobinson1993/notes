import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import type { Push } from '../push.js';
import { requireAuth } from '../session.js';

// Web Push subscription management. The browser creates a PushSubscription with
// our VAPID public key and uploads it here; the server later uses it to send
// content-free "new message" pings (see push.ts + spec/notifications.md).

const MAX_ENDPOINT = 2048;
const MAX_KEY = 256;

export function pushRoutes(app: FastifyInstance, db: DB, push: Push): void {
  // The VAPID public key the client needs to subscribe (null disables push).
  app.get('/api/push/key', { preHandler: requireAuth }, async () => ({
    publicKey: push.publicKey,
  }));

  app.post('/api/push/subscribe', { preHandler: requireAuth }, async (request, reply) => {
    const b = request.body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
    const endpoint = b?.endpoint;
    const p256dh = b?.keys?.p256dh;
    const auth = b?.keys?.auth;
    if (
      typeof endpoint !== 'string' ||
      endpoint.length < 1 ||
      endpoint.length > MAX_ENDPOINT ||
      !endpoint.startsWith('https://') ||
      typeof p256dh !== 'string' ||
      p256dh.length < 1 ||
      p256dh.length > MAX_KEY ||
      typeof auth !== 'string' ||
      auth.length < 1 ||
      auth.length > MAX_KEY
    ) {
      return reply.code(400).send({ error: 'invalid subscription' });
    }
    db.addPushSubscription({ userId: request.user!.id, endpoint, p256dh, auth });
    return { ok: true };
  });

  app.post('/api/push/unsubscribe', { preHandler: requireAuth }, async (request, reply) => {
    const b = request.body as { endpoint?: unknown } | null;
    if (typeof b?.endpoint !== 'string' || b.endpoint.length > MAX_ENDPOINT) {
      return reply.code(400).send({ error: 'invalid endpoint' });
    }
    db.deletePushSubscription(request.user!.id, b.endpoint);
    return { ok: true };
  });
}
