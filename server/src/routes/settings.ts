import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import { requireAuth } from '../session.js';

// Per-user opaque settings blobs. The client encrypts values with the master
// key before upload (e.g. tag colors), so the server never sees plaintext.

const KEY_RE = /^[a-z0-9-]{1,64}$/;
const MAX_DATA_BYTES = 64 * 1024;

export function settingsRoutes(app: FastifyInstance, db: DB): void {
  app.get('/api/settings/:key', { preHandler: requireAuth }, async (request, reply) => {
    const { key } = request.params as { key: string };
    if (!KEY_RE.test(key)) return reply.code(400).send({ error: 'invalid key' });
    const row = db.getUserSetting(request.user!.id, key);
    return row ? { data: row.data, updatedAt: row.updated_at } : null;
  });

  app.put('/api/settings/:key', { preHandler: requireAuth }, async (request, reply) => {
    const { key } = request.params as { key: string };
    if (!KEY_RE.test(key)) return reply.code(400).send({ error: 'invalid key' });
    const b = request.body as Record<string, unknown> | null;
    if (typeof b?.data !== 'string' || b.data.length > MAX_DATA_BYTES) {
      return reply.code(400).send({ error: 'invalid data' });
    }
    const updatedAt = db.putUserSetting(request.user!.id, key, b.data);
    return { updatedAt };
  });
}
