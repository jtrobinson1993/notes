// Native-shell notes backend (D2 local-first read/write path).
//
// The webview owns a Y.Doc per note (the future y-codemirror binding target);
// the Rust core persists the encoded doc + display metadata. Body edits are
// applied to the doc as a coarse replace inside one transaction — a single
// doc lineage per note, refined into real collaborative editing in phase 4.

import * as Y from 'yjs';
import type { NotePayload, ShareAccess } from '@notes/shared';
import { noteCreate, noteDelete, noteSave, notesLoadAll } from './native';
import type { DecryptedNote } from '../stores/notes';

const docs = new Map<string, Y.Doc>();

function ensureDoc(id: string): Y.Doc {
  let doc = docs.get(id);
  if (!doc) {
    doc = new Y.Doc();
    docs.set(id, doc);
  }
  return doc;
}

/** Startup: hydrate every note (meta + doc) from the local store. */
export async function nativeLoadNotes(): Promise<DecryptedNote[]> {
  const rows = await notesLoadAll();
  return rows.map(({ meta, ydoc_state }) => {
    const doc = new Y.Doc();
    if (ydoc_state?.length) Y.applyUpdate(doc, Uint8Array.from(ydoc_state));
    docs.set(meta.id, doc);
    const shared = meta.shared_json
      ? (JSON.parse(meta.shared_json) as { owner: string; access: ShareAccess })
      : null;
    return {
      id: meta.id,
      payload: {
        title: meta.title ?? '',
        body: doc.getText('content').toString(),
        tags: meta.tags_json ? (JSON.parse(meta.tags_json) as string[]) : [],
      },
      createdAt: meta.created,
      updatedAt: meta.updated,
      ...(shared ? { shared: { ownerDisplayName: shared.owner, access: shared.access } } : {}),
    };
  });
}

export async function nativeCreateNote(id: string): Promise<void> {
  ensureDoc(id);
  await noteCreate(id);
}

export async function nativeSaveNote(id: string, payload: NotePayload): Promise<void> {
  const doc = ensureDoc(id);
  const text = doc.getText('content');
  if (text.toString() !== payload.body) {
    doc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, payload.body);
    });
  }
  const search = payload.tags.length
    ? `${payload.body}\n${payload.tags.join(' ')}`
    : payload.body;
  await noteSave(
    id,
    payload.title,
    search,
    JSON.stringify(payload.tags),
    Array.from(Y.encodeStateAsUpdate(doc)),
  );
}

export async function nativeDeleteNote(id: string): Promise<void> {
  docs.delete(id);
  await noteDelete(id);
}

export function resetNativeNotes(): void {
  docs.clear();
}
