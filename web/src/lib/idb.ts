import { openDB, type IDBPDatabase } from 'idb';
import type { NoteRecord, SharedNoteRecord, WrappedKey } from '@notes/shared';

interface MetaValues {
  userId: string;
  lastSync: number;
}

/** A locally-queued save that couldn't reach the server (offline editing). */
export interface OutboxEntry {
  noteId: string;
  ciphertext: string;
  iv: string;
  /** present for owned notes only */
  wrappedKey?: WrappedKey;
  createdAt: number;
  baseUpdatedAt?: number;
  queuedAt: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB('notes-cache', 2, {
    upgrade(d, oldVersion) {
      if (oldVersion < 1) {
        d.createObjectStore('notes', { keyPath: 'id' });
        d.createObjectStore('meta');
      }
      if (oldVersion < 2) {
        d.createObjectStore('shared', { keyPath: 'id' });
        d.createObjectStore('outbox', { keyPath: 'noteId' });
      }
    },
  });
  return dbPromise;
}

export async function getCachedNotes(): Promise<NoteRecord[]> {
  return (await db()).getAll('notes') as Promise<NoteRecord[]>;
}

export async function putCachedNotes(records: NoteRecord[]): Promise<void> {
  const tx = (await db()).transaction('notes', 'readwrite');
  await Promise.all(records.map((r) => tx.store.put(r)));
  await tx.done;
}

export async function removeCachedNote(id: string): Promise<void> {
  await (await db()).delete('notes', id);
}

export async function getCachedShared(): Promise<SharedNoteRecord[]> {
  return (await db()).getAll('shared') as Promise<SharedNoteRecord[]>;
}

/** Shared notes are reconciled as a full list (no since-cursor). */
export async function replaceCachedShared(records: SharedNoteRecord[]): Promise<void> {
  const tx = (await db()).transaction('shared', 'readwrite');
  await tx.store.clear();
  await Promise.all(records.map((r) => tx.store.put(r)));
  await tx.done;
}

export async function getOutbox(): Promise<OutboxEntry[]> {
  return (await db()).getAll('outbox') as Promise<OutboxEntry[]>;
}

export async function putOutbox(entry: OutboxEntry): Promise<void> {
  await (await db()).put('outbox', entry);
}

export async function removeOutbox(noteId: string): Promise<void> {
  await (await db()).delete('outbox', noteId);
}

export async function getCacheMeta<K extends keyof MetaValues>(key: K): Promise<MetaValues[K] | undefined> {
  return (await db()).get('meta', key) as Promise<MetaValues[K] | undefined>;
}

export async function setCacheMeta<K extends keyof MetaValues>(key: K, value: MetaValues[K]): Promise<void> {
  await (await db()).put('meta', value, key);
}

export async function clearCache(): Promise<void> {
  const d = await db();
  await Promise.all([d.clear('notes'), d.clear('shared'), d.clear('outbox'), d.clear('meta')]);
}

/** Drop the cache when a different user logs in on this browser. */
export async function ensureCacheOwner(userId: string): Promise<void> {
  const owner = await getCacheMeta('userId');
  if (owner !== userId) {
    await clearCache();
    await setCacheMeta('userId', userId);
  }
}
