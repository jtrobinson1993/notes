import type { FastifyInstance } from 'fastify';
import type { MemberInfo, NotesSyncResponse, SealedKey, ShareInfo, SharedNoteRecord, WrappedKey } from '@notes/shared';
import { effectiveDisplayName, toNoteRecord, type DB } from '../db.js';
import { requireAuth } from '../session.js';
import { now, validWrappedKey } from '../util.js';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NOTE_BYTES = 1024 * 1024; // 1 MiB ciphertext per note

function validSealedKey(s: unknown): boolean {
  if (typeof s !== 'object' || s === null) return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.epk === 'string' && o.epk.length < 256 &&
    typeof o.iv === 'string' && o.iv.length < 256 &&
    typeof o.ct === 'string' && o.ct.length < 1024
  );
}

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
      typeof b.iv !== 'string' || b.iv.length > 256
    ) {
      return reply.code(400).send({ error: 'invalid note payload' });
    }
    const existing = db.getNote(id);
    const isOwner = !existing || existing.user_id === request.user!.id;
    if (existing && !isOwner) {
      const share = db.getShare(id, request.user!.id);
      if (!share || share.access !== 'write' || existing.deleted) {
        return reply.code(403).send({ error: 'not your note' });
      }
    }
    // Multi-device / multi-editor conflict detection: the client sends the
    // updatedAt its edit was based on; a mismatch means someone else saved.
    if (existing && typeof b.baseUpdatedAt === 'number' && b.baseUpdatedAt !== existing.updated_at) {
      return reply.code(409).send({ error: 'conflict', serverNote: toNoteRecord(existing) });
    }
    // The wrapped key belongs to the owner; share recipients must not replace it.
    let wrappedKey: WrappedKey;
    if (existing && !isOwner) {
      wrappedKey = JSON.parse(existing.wrapped_key) as WrappedKey;
    } else {
      if (!validWrappedKey(b.wrappedKey)) return reply.code(400).send({ error: 'invalid wrapped key' });
      wrappedKey = b.wrappedKey as WrappedKey;
    }
    if (existing && !existing.deleted) db.snapshotVersion(existing);
    const createdAt = existing?.created_at ?? (typeof b.createdAt === 'number' ? b.createdAt : now());
    const updatedAt = db.upsertNote({
      id,
      userId: existing?.user_id ?? request.user!.id,
      ciphertext: b.ciphertext,
      iv: b.iv,
      wrappedKey,
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

  // ---- Versions ----

  app.get('/api/notes/:id/versions', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const note = db.getNote(id);
    const allowed = note && (note.user_id === request.user!.id || db.getShare(id, request.user!.id));
    if (!allowed) return reply.code(404).send({ error: 'not found' });
    return db.listVersions(id).map((v) => ({ id: v.id, createdAt: v.created_at }));
  });

  app.get('/api/notes/:id/versions/:vid', { preHandler: requireAuth }, async (request, reply) => {
    const { id, vid } = request.params as { id: string; vid: string };
    const note = db.getNote(id);
    const allowed = note && (note.user_id === request.user!.id || db.getShare(id, request.user!.id));
    if (!allowed) return reply.code(404).send({ error: 'not found' });
    const version = db.getVersion(id, Number(vid));
    if (!version) return reply.code(404).send({ error: 'not found' });
    return {
      id: version.id,
      ciphertext: version.ciphertext,
      iv: version.iv,
      wrappedKey: JSON.parse(version.wrapped_key) as WrappedKey,
      createdAt: version.created_at,
    };
  });

  // ---- Sharing ----

  // Share targets (v5): your friends plus anyone you share a conversation with —
  // by display name, never the username.
  app.get('/api/members', { preHandler: requireAuth }, async (request) => {
    return db.listShareableMembers(request.user!.id).map(
      (m): MemberInfo => ({
        id: m.id,
        displayName: effectiveDisplayName({ id: m.id, display_name: m.display_name }),
        publicKey: m.public_key,
      }),
    );
  });

  app.get('/api/shared', { preHandler: requireAuth }, async (request) => {
    return db.listSharedWith(request.user!.id).map(
      (r): SharedNoteRecord => ({
        id: r.id,
        ciphertext: r.ciphertext,
        iv: r.iv,
        sealedKey: JSON.parse(r.sealed_key) as SealedKey,
        ownerDisplayName: effectiveDisplayName({ id: r.owner_id, display_name: r.owner_display_name }),
        access: r.access as SharedNoteRecord['access'],
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }),
    );
  });

  app.get('/api/notes/:id/shares', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const note = db.getNote(id);
    if (!note || note.user_id !== request.user!.id) return reply.code(404).send({ error: 'not found' });
    return db.listShares(id).map(
      (s): ShareInfo => ({
        noteId: s.note_id,
        recipientId: s.recipient_id,
        recipientDisplayName: effectiveDisplayName({ id: s.recipient_id, display_name: s.recipient_display_name }),
        access: s.access as ShareInfo['access'],
        createdAt: s.created_at,
      }),
    );
  });

  app.post('/api/notes/:id/shares', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const me = request.user!.id;
    const b = request.body as Record<string, unknown>;
    const note = db.getNote(id);
    if (!note || note.user_id !== me || note.deleted) {
      return reply.code(404).send({ error: 'not found' });
    }
    if (typeof b.recipientId !== 'string' || !validSealedKey(b.sealedKey) || (b.access !== 'read' && b.access !== 'write')) {
      return reply.code(400).send({ error: 'invalid share payload' });
    }
    if (b.recipientId === me) return reply.code(400).send({ error: 'cannot share with yourself' });
    // v5: you may share with a friend OR a conversation co-member (a
    // friend-of-friend you already share a group with).
    if (!db.areFriends(me, b.recipientId) && !db.sharesConversation(me, b.recipientId)) {
      return reply.code(403).send({ error: 'not a friend or co-member' });
    }
    const recipient = db.getUser(b.recipientId);
    if (!recipient?.public_key) return reply.code(400).send({ error: 'recipient has no public key yet' });
    db.upsertShare({ noteId: id, recipientId: b.recipientId, sealedKey: JSON.stringify(b.sealedKey), access: b.access });
    return { ok: true };
  });

  app.delete('/api/notes/:id/shares/:recipientId', { preHandler: requireAuth }, async (request, reply) => {
    const { id, recipientId } = request.params as { id: string; recipientId: string };
    const note = db.getNote(id);
    // The owner can revoke anyone; a recipient can remove themselves.
    const isOwner = note?.user_id === request.user!.id;
    if (!note || (!isOwner && recipientId !== request.user!.id)) {
      return reply.code(404).send({ error: 'not found' });
    }
    db.deleteShare(id, recipientId);
    return { ok: true };
  });
}
