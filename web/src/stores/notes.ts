import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { NotePayload, NoteRecord } from '@notes/shared';
import { api } from '../lib/api';
import { decryptNotePayload, encryptNotePayload } from '../lib/crypto';
import {
  ensureCacheOwner,
  getCacheMeta,
  getCachedNotes,
  putCachedNotes,
  removeCachedNote,
  setCacheMeta,
} from '../lib/idb';
import { useSessionStore } from './session';

export interface DecryptedNote {
  id: string;
  payload: NotePayload;
  createdAt: number;
  updatedAt: number;
}

export const useNotesStore = defineStore('notes', () => {
  const session = useSessionStore();
  const notes = ref(new Map<string, DecryptedNote>());
  const records = new Map<string, NoteRecord>(); // ciphertext records (for key reuse)
  const loaded = ref(false);
  const syncing = ref(false);
  const syncError = ref<string | null>(null);

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

  /** Instant load: decrypt whatever is in IndexedDB. */
  async function loadFromCache(): Promise<void> {
    if (!session.user) return;
    await ensureCacheOwner(session.user.id);
    const cached = await getCachedNotes();
    for (const record of cached) {
      try {
        await ingest(record);
      } catch {
        await removeCachedNote(record.id); // corrupt entry; refetched on sync
      }
    }
    loaded.value = true;
  }

  /** Background sync: fetch changes since the last cursor, merge, persist. */
  async function sync(): Promise<void> {
    if (syncing.value || !session.user) return;
    syncing.value = true;
    syncError.value = null;
    try {
      const since = (await getCacheMeta('lastSync')) ?? 0;
      const { notes: changed, serverTime } = await api.notes(since);
      const live = changed.filter((r) => !r.deleted);
      for (const record of changed) await ingest(record);
      await putCachedNotes(live);
      await setCacheMeta('lastSync', serverTime);
      loaded.value = true;
    } catch (e) {
      syncError.value = e instanceof Error ? e.message : 'sync failed';
    } finally {
      syncing.value = false;
    }
  }

  async function save(id: string, payload: NotePayload): Promise<void> {
    const existing = records.get(id);
    const createdAt = existing?.createdAt ?? Date.now();
    const data = await encryptNotePayload(mk(), payload, existing?.wrappedKey);

    // Optimistic local update so typing feels instant even offline.
    notes.value.set(id, { id, payload, createdAt, updatedAt: Date.now() });

    const { updatedAt } = await api.notePut(id, { ...data, createdAt });
    const record: NoteRecord = { id, ...data, createdAt, updatedAt, deleted: false };
    records.set(id, record);
    notes.value.set(id, { id, payload, createdAt, updatedAt });
    await putCachedNotes([record]);
  }

  async function create(): Promise<string> {
    const id = crypto.randomUUID();
    await save(id, { title: '', body: '', tags: [] });
    return id;
  }

  async function remove(id: string): Promise<void> {
    notes.value.delete(id);
    records.delete(id);
    await removeCachedNote(id);
    await api.noteDelete(id);
  }

  function reset(): void {
    notes.value = new Map();
    records.clear();
    loaded.value = false;
  }

  return { notes, sorted, allTags, loaded, syncing, syncError, loadFromCache, sync, save, create, remove, reset };
});
