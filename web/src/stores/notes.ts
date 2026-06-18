import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { NotePayload, NoteRecord, ShareAccess, SharedNoteRecord } from '@notes/shared';
import { api, ApiError } from '../lib/api';
import {
  decryptNotePayload,
  decryptSharedNotePayload,
  encryptNotePayload,
  encryptWithNoteKey,
  sealKey,
  unwrapNoteKey,
} from '../lib/crypto';
import { ub64 } from '../lib/b64';
import {
  ensureCacheOwner,
  getCacheMeta,
  getCachedNotes,
  getCachedShared,
  getOutbox,
  putCachedNotes,
  putOutbox,
  removeCachedNote,
  removeOutbox,
  replaceCachedShared,
  setCacheMeta,
  type OutboxEntry,
} from '../lib/idb';
import { useSessionStore } from './session';
import { useOrgStore } from './organization';

export interface DecryptedNote {
  id: string;
  payload: NotePayload;
  createdAt: number;
  updatedAt: number;
  /** set when this note is shared *with* me */
  shared?: { ownerDisplayName: string; access: ShareAccess };
}

export const useNotesStore = defineStore('notes', () => {
  const session = useSessionStore();
  const notes = ref(new Map<string, DecryptedNote>());
  const records = new Map<string, NoteRecord>(); // owned ciphertext records
  const sharedNoteKeys = new Map<string, Uint8Array>(); // raw note keys for shared-with-me notes
  const loaded = ref(false);
  const syncing = ref(false);
  const syncError = ref<string | null>(null);
  const pendingCount = ref(0);

  const sorted = computed(() =>
    [...notes.value.values()].sort((a, b) => b.updatedAt - a.updatedAt),
  );
  const allTags = computed(() => {
    const tags = new Set<string>();
    for (const n of notes.value.values()) for (const t of n.payload.tags) tags.add(t);
    return [...tags].sort();
  });

  function mk(): Uint8Array {
    if (!session.mk) throw new Error('locked');
    return session.mk;
  }

  async function ingest(record: NoteRecord): Promise<void> {
    if (record.deleted) {
      notes.value.delete(record.id);
      records.delete(record.id);
      await removeCachedNote(record.id);
      return;
    }
    records.set(record.id, record);
    const payload = await decryptNotePayload(mk(), record);
    notes.value.set(record.id, {
      id: record.id,
      payload,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  async function ingestShared(record: SharedNoteRecord): Promise<void> {
    const { privateKey, publicKey } = await session.getKeyPair();
    const { payload, noteKeyRaw } = await decryptSharedNotePayload(privateKey, publicKey, record);
    sharedNoteKeys.set(record.id, noteKeyRaw);
    notes.value.set(record.id, {
      id: record.id,
      payload,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      shared: { ownerDisplayName: record.ownerDisplayName, access: record.access },
    });
  }

  /** Instant load: decrypt whatever is in IndexedDB. */
  async function loadFromCache(): Promise<void> {
    if (!session.user) return;
    await ensureCacheOwner(session.user.id);
    for (const record of await getCachedNotes()) {
      try {
        await ingest(record);
      } catch {
        await removeCachedNote(record.id); // corrupt entry; refetched on sync
      }
    }
    try {
      for (const record of await getCachedShared()) await ingestShared(record);
    } catch {
      // shared cache decryption needs the network once (keypair fetch); sync will recover
    }
    pendingCount.value = (await getOutbox()).length;
    loaded.value = true;
  }

  /** Push queued offline edits before pulling. 409s become conflict copies. */
  async function flushOutbox(): Promise<void> {
    for (const entry of await getOutbox()) {
      try {
        const { updatedAt } = await api.notePut(entry.noteId, {
          ciphertext: entry.ciphertext,
          iv: entry.iv,
          wrappedKey: entry.wrappedKey,
          createdAt: entry.createdAt,
          baseUpdatedAt: entry.baseUpdatedAt,
        });
        const local = notes.value.get(entry.noteId);
        if (local) local.updatedAt = updatedAt;
        await removeOutbox(entry.noteId);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          await makeConflictCopy(entry);
          await removeOutbox(entry.noteId);
        } else if (e instanceof ApiError) {
          await removeOutbox(entry.noteId); // permanent rejection; drop rather than wedge sync
        }
        // network errors: keep queued
      }
    }
    pendingCount.value = (await getOutbox()).length;
  }

  /** Our queued edit lost the race: preserve it as a new note. */
  async function makeConflictCopy(entry: OutboxEntry): Promise<void> {
    try {
      let payload: NotePayload;
      if (entry.wrappedKey) {
        payload = await decryptNotePayload(mk(), {
          id: entry.noteId, ciphertext: entry.ciphertext, iv: entry.iv,
          wrappedKey: entry.wrappedKey, createdAt: entry.createdAt, updatedAt: 0, deleted: false,
        });
      } else {
        const noteKey = sharedNoteKeys.get(entry.noteId);
        if (!noteKey) return;
        const key = await crypto.subtle.importKey('raw', noteKey as BufferSource, 'AES-GCM', false, ['decrypt']);
        const pt = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: ub64(entry.iv) as BufferSource }, key, ub64(entry.ciphertext) as BufferSource,
        );
        payload = JSON.parse(new TextDecoder().decode(pt)) as NotePayload;
      }
      payload.title = `${payload.title || 'Untitled'} (conflict copy)`;
      await save(crypto.randomUUID(), payload);
    } catch {
      // conflict copy is best-effort; the server version wins regardless
    }
  }

  /** Background sync: outbox first, then owned (since-cursor) + shared (full). */
  async function sync(): Promise<void> {
    if (syncing.value || !session.user) return;
    syncing.value = true;
    syncError.value = null;
    try {
      await flushOutbox();
      const since = (await getCacheMeta('lastSync')) ?? 0;
      const { notes: changed, serverTime } = await api.notes(since);
      for (const record of changed) await ingest(record);
      await putCachedNotes(changed.filter((r) => !r.deleted));
      await setCacheMeta('lastSync', serverTime);

      const shared = await api.sharedNotes();
      const sharedIds = new Set(shared.map((r) => r.id));
      for (const [id, note] of notes.value) {
        if (note.shared && !sharedIds.has(id)) notes.value.delete(id); // unshared/revoked
      }
      for (const record of shared) {
        const existing = notes.value.get(record.id);
        // Skip re-decrypting a shared note we already hold at the same version.
        // sync() runs on every focus/reconnect, and unsealing a shared note is
        // an X25519 + AES operation — re-running it for unchanged notes is the
        // bulk of sync's wasted crypto.
        if (existing?.shared && existing.updatedAt === record.updatedAt) continue;
        await ingestShared(record);
      }
      await replaceCachedShared(shared);
      loaded.value = true;
    } catch (e) {
      syncError.value = e instanceof Error ? e.message : 'sync failed';
    } finally {
      syncing.value = false;
    }
  }

  async function save(id: string, payload: NotePayload): Promise<void> {
    const existing = notes.value.get(id);
    const sharedKey = sharedNoteKeys.get(id);
    const ownedRecord = records.get(id);
    const createdAt = existing?.createdAt ?? Date.now();
    const baseUpdatedAt = existing?.updatedAt;

    let data: { ciphertext: string; iv: string; wrappedKey?: NoteRecord['wrappedKey'] };
    if (sharedKey) {
      data = await encryptWithNoteKey(sharedKey, payload);
    } else {
      data = await encryptNotePayload(mk(), payload, ownedRecord?.wrappedKey);
    }

    // Optimistic local update so typing feels instant even offline.
    notes.value.set(id, { ...existing, id, payload, createdAt, updatedAt: Date.now() });

    try {
      const { updatedAt } = await api.notePut(id, { ...data, createdAt, baseUpdatedAt });
      const local = notes.value.get(id);
      if (local) local.updatedAt = updatedAt;
      if (!sharedKey && data.wrappedKey) {
        const record: NoteRecord = {
          id, ciphertext: data.ciphertext, iv: data.iv, wrappedKey: data.wrappedKey,
          createdAt, updatedAt, deleted: false,
        };
        records.set(id, record);
        await putCachedNotes([record]);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        await makeConflictCopy({ noteId: id, ...data, createdAt, baseUpdatedAt, queuedAt: Date.now() });
        await sync();
        return;
      }
      // Offline (or server unreachable): queue and reconcile on next sync.
      await putOutbox({ noteId: id, ...data, createdAt, baseUpdatedAt, queuedAt: Date.now() });
      pendingCount.value = (await getOutbox()).length;
    }
  }

  async function create(initial?: Partial<NotePayload>): Promise<string> {
    const id = crypto.randomUUID();
    await save(id, { title: '', body: '', tags: [], ...initial });
    return id;
  }

  async function remove(id: string): Promise<void> {
    notes.value.delete(id);
    records.delete(id);
    sharedNoteKeys.delete(id);
    // Drop any folder assignment + sidebar pins for this note.
    useOrgStore().forgetNote(id);
    await removeCachedNote(id);
    await removeOutbox(id);
    await api.noteDelete(id);
  }

  // ---- Sharing (owner side) ----

  async function shareWith(noteId: string, recipientId: string, recipientPublicKey: string, access: ShareAccess): Promise<void> {
    const record = records.get(noteId);
    if (!record) throw new Error('note not found');
    const noteKey = await unwrapNoteKey(mk(), record.wrappedKey);
    const sealed = await sealKey(ub64(recipientPublicKey), noteKey);
    await api.shareNote(noteId, recipientId, sealed, access);
  }

  /** Re-encrypt an OWNED note under a fresh key, wrapped under MK, and store it.
   *  Returns the raw new key so callers can re-seal it to remaining recipients. */
  async function rotateNoteKey(noteId: string): Promise<Uint8Array> {
    const note = notes.value.get(noteId);
    const record = records.get(noteId);
    if (!note || !record) throw new Error('note not found');
    // No existing wrappedKey passed → encryptNotePayload mints a fresh note key.
    const data = await encryptNotePayload(mk(), note.payload);
    const { updatedAt } = await api.notePut(noteId, {
      ciphertext: data.ciphertext,
      iv: data.iv,
      wrappedKey: data.wrappedKey,
      createdAt: note.createdAt,
      baseUpdatedAt: note.updatedAt,
    });
    const fresh: NoteRecord = {
      id: noteId, ciphertext: data.ciphertext, iv: data.iv, wrappedKey: data.wrappedKey!,
      createdAt: note.createdAt, updatedAt, deleted: false,
    };
    records.set(noteId, fresh);
    await putCachedNotes([fresh]);
    const local = notes.value.get(noteId);
    if (local) local.updatedAt = updatedAt;
    return unwrapNoteKey(mk(), data.wrappedKey!);
  }

  /** Revoke a recipient AND rotate the note key so they can't read future
   *  updates (prior plaintext they held is considered compromised). Re-seals the
   *  fresh key to every remaining recipient. */
  async function revokeShare(noteId: string, recipientId: string): Promise<void> {
    if (!records.get(noteId)) throw new Error('not the owner');
    await api.unshareNote(noteId, recipientId);
    const newKey = await rotateNoteKey(noteId);
    const remaining = (await api.noteShares(noteId)).filter((s) => s.recipientId !== recipientId);
    if (!remaining.length) return;
    const pubById = new Map((await api.members()).map((m) => [m.id, m.publicKey]));
    for (const s of remaining) {
      const pk = pubById.get(s.recipientId);
      if (!pk) continue; // relationship gone → can't re-seal; their access lapses
      await api.shareNote(noteId, s.recipientId, await sealKey(ub64(pk), newKey), s.access);
    }
  }

  /** Recursively share every OWNED note in a folder (and its subfolders) with
   *  each recipient — a one-time snapshot grant (no folder permission record).
   *  Shared-with-me notes in the folder are skipped (only the owner can share). */
  async function shareFolder(
    folderId: string,
    recipients: { id: string; publicKey: string | null }[],
    access: ShareAccess,
  ): Promise<void> {
    const org = useOrgStore();
    const folderIds = new Set(org.descendantFolderIds(folderId));
    const owned = [...notes.value.values()].filter((n) => {
      const f = org.folderOf(n.id);
      return !n.shared && f !== null && folderIds.has(f) && records.has(n.id);
    });
    for (const n of owned) {
      for (const r of recipients) {
        if (r.publicKey) await shareWith(n.id, r.id, r.publicKey, access);
      }
    }
  }

  function reset(): void {
    notes.value = new Map();
    records.clear();
    sharedNoteKeys.clear();
    loaded.value = false;
  }

  return {
    notes, sorted, allTags, loaded, syncing, syncError, pendingCount,
    loadFromCache, sync, save, create, remove, shareWith, revokeShare, shareFolder, reset,
  };
});
