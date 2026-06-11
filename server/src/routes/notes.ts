import type { FastifyInstance } from 'fastify';
import type { NotesSyncResponse, WrappedKey } from '@notes/shared';
import { toNoteRecord, type DB } from '../db.js';
import { requireAuth } from '../session.js';
import { now, validWrappedKey } from '../util.js';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NOTE_BYTES = 1024 * 1024; // 1 MiB ciphertext per note

export function noteRoutes(app: FastifyInstance, db: DB): void {
  app.get('/api/notes', { preHandler: requireAuth }, async (request) => {
    const { since } = request.query as { since?: string };
    const sinceTs = since ? Number(since) : 0;
    const result: NotesSyncResponse = {
      notes: db.listNotes(request.user!.id, Number.isFinite(sinceTs) ? sinceTs : 0).map(toNoteRecord),
      serverTime: now(),
    };
    return result;
  });

  app.put('/api/notes/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const b = request.body as Record<string, unknown>;
    if (!ID_RE.test(id)) return reply.code(400).send({ error: 'invalid note id' });
    if (
      typeof b.ciphertext !== 'string' || b.ciphertext.length > MAX_NOTE_BYTES ||
      typeof b.iv !== 'string' || b.iv.length > 256 ||
      !validWrappedKey(b.wrappedKey)
    ) {
      return reply.code(400).send({ error: 'invalid note payload' });
    }
    const existing = db.getNote(id);
    if (existing && existing.user_id !== request.user!.id) {
      return reply.code(403).send({ error: 'not your note' });
    }
    const createdAt = existing?.created_at ?? (typeof b.createdAt === 'number' ? b.createdAt : now());
    const updatedAt = db.upsertNote({
      id,
      userId: request.user!.id,
      ciphertext: b.ciphertext,
      iv: b.iv,
      wrappedKey: b.wrappedKey as WrappedKey,
      createdAt,
    });
    return { id, updatedAt };
  });

  app.delete('/api/notes/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = db.getNote(id);
    if (!existing || existing.user_id !== request.user!.id) {
      return reply.code(404).send({ error: 'not found' });
    }
    const updatedAt = db.deleteNote(id);
    return { id, updatedAt };
  });
}
