import { openDB, type IDBPDatabase } from 'idb';
import type { NoteRecord } from '@notes/shared';

interface MetaValues {
  userId: string;
  lastSync: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB('notes-cache', 1, {
    upgrade(d) {
      d.createObjectStore('notes', { keyPath: 'id' });
      d.createObjectStore('meta');
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

export async function getCacheMeta<K extends keyof MetaValues>(key: K): Promise<MetaValues[K] | undefined> {
  return (await db()).get('meta', key) as Promise<MetaValues[K] | undefined>;
}

export async function setCacheMeta<K extends keyof MetaValues>(key: K, value: MetaValues[K]): Promise<void> {
  await (await db()).put('meta', value, key);
}

export async function clearCache(): Promise<void> {
  const d = await db();
  await d.clear('notes');
  await d.clear('meta');
}

/** Drop the cache when a different user logs in on this browser. */
export async function ensureCacheOwner(userId: string): Promise<void> {
  const owner = await getCacheMeta('userId');
  if (owner !== userId) {
    await clearCache();
    await setCacheMeta('userId', userId);
  }
}
