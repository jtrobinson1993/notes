import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { requireAuth } from '../session.js';
import { newToken } from '../util.js';

const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Attachments are encrypted client-side with a key stored *inside* the
 * encrypted note payload, so the server cannot tell which note an attachment
 * belongs to. Downloads therefore require auth + the unguessable 256-bit id
 * (capability style) rather than per-note ACLs — the blob is ciphertext
 * either way. */
export function attachmentRoutes(app: FastifyInstance, db: DB, config: Config): void {
  const blobDir = join(config.dataDir, 'blobs');

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_ATTACHMENT_BYTES }, (_req, body, done) => {
    done(null, body);
  });

  app.post('/api/attachments', { preHandler: requireAuth, bodyLimit: MAX_ATTACHMENT_BYTES }, async (request, reply) => {
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: 'expected application/octet-stream body' });
    }
    const id = newToken();
    await mkdir(blobDir, { recursive: true });
    await writeFile(join(blobDir, id), body);
    db.createAttachment({ id, userId: request.user!.id, size: body.length });
    return { id, size: body.length };
  });

  app.get('/api/attachments/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ID_RE.test(id) || !db.getAttachment(id)) return reply.code(404).send({ error: 'not found' });
    const path = join(blobDir, id);
    try {
      const info = await stat(path);
      reply.header('content-type', 'application/octet-stream');
      reply.header('content-length', info.size);
      reply.header('cache-control', 'private, max-age=31536000, immutable');
      return reply.send(createReadStream(path));
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
  });

  app.delete('/api/attachments/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const att = ID_RE.test(id) ? db.getAttachment(id) : undefined;
    if (!att || att.user_id !== request.user!.id) return reply.code(404).send({ error: 'not found' });
    db.deleteAttachment(id);
    await unlink(join(blobDir, id)).catch(() => {});
    return { ok: true };
  });
}
