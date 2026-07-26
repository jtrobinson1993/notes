import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { NotePayload, ShareAccess } from '@notes/shared';
import { useOrgStore } from './organization';
import {
  nativeCreateNote,
  nativeDeleteNote,
  nativeLoadNotes,
  nativeSaveNote,
  resetNativeNotes,
} from '../lib/nativeNotes';

export interface DecryptedNote {
  id: string;
  payload: NotePayload;
  createdAt: number;
  updatedAt: number;
  /** set when this note is shared *with* me */
  shared?: { ownerDisplayName: string; access: ShareAccess };
}

// Notes are local-first: the encrypted vault (SQLCipher, via the Rust core) is
// the source of truth — there is no server copy, so no outbox, conflict-copy or
// share model here. Relay-backed sync and sharing land in a later phase.
export const useNotesStore = defineStore('notes', () => {
  const notes = ref(new Map<string, DecryptedNote>());
  const loaded = ref(false);

  const sorted = computed(() =>
    [...notes.value.values()].sort((a, b) => b.updatedAt - a.updatedAt),
  );
  const allTags = computed(() => {
    const tags = new Set<string>();
    for (const n of notes.value.values()) for (const t of n.payload.tags) tags.add(t);
    return [...tags].sort();
  });

  /** Load every note from the local store (instant; no network). */
  async function loadFromCache(): Promise<void> {
    for (const n of await nativeLoadNotes()) notes.value.set(n.id, n);
    loaded.value = true;
  }

  async function save(id: string, payload: NotePayload): Promise<void> {
    const prior = notes.value.get(id);
    notes.value.set(id, {
      ...prior,
      id,
      payload,
      createdAt: prior?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    });
    await nativeSaveNote(id, payload);
  }

  async function create(initial?: Partial<NotePayload>): Promise<string> {
    const id = crypto.randomUUID();
    await nativeCreateNote(id);
    await save(id, { title: '', body: '', tags: [], ...initial });
    return id;
  }

  async function remove(id: string): Promise<void> {
    notes.value.delete(id);
    // Drop any folder assignment + sidebar pins for this note.
    useOrgStore().forgetNote(id);
    await nativeDeleteNote(id);
  }

  /** Drop every decrypted note (on lock) — plaintext must not outlive the key. */
  function reset(): void {
    notes.value = new Map();
    resetNativeNotes();
    loaded.value = false;
  }

  return {
    notes, sorted, allTags, loaded,
    loadFromCache, save, create, remove, reset,
  };
});
