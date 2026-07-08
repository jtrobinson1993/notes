import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const native = vi.hoisted(() => ({
  notesLoadAll: vi.fn(),
  noteCreate: vi.fn(),
  noteSave: vi.fn(),
  noteDelete: vi.fn(),
}));
vi.mock('../../src/lib/native', () => native);

import {
  nativeCreateNote,
  nativeDeleteNote,
  nativeLoadNotes,
  nativeSaveNote,
  resetNativeNotes,
} from '../../src/lib/nativeNotes';

function encodeBody(body: string): number[] {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, body);
  return Array.from(Y.encodeStateAsUpdate(doc));
}

beforeEach(() => {
  vi.resetAllMocks();
  resetNativeNotes();
});

describe('nativeLoadNotes', () => {
  it('hydrates payloads from doc state, tags, and shared metadata', async () => {
    native.notesLoadAll.mockResolvedValue([
      {
        meta: {
          id: 'n1',
          title: 'Own note',
          folder_id: null,
          shared_json: null,
          tags_json: '["work","later"]',
          created: 10,
          updated: 20,
        },
        ydoc_state: encodeBody('own body'),
      },
      {
        meta: {
          id: 'n2',
          title: 'Their note',
          folder_id: null,
          shared_json: '{"owner":"Alice","access":"view"}',
          tags_json: null,
          created: 1,
          updated: 2,
        },
        ydoc_state: null,
      },
    ]);
    const [own, theirs] = await nativeLoadNotes();
    expect(own).toMatchObject({
      id: 'n1',
      payload: { title: 'Own note', body: 'own body', tags: ['work', 'later'] },
      createdAt: 10,
      updatedAt: 20,
    });
    expect(own.shared).toBeUndefined();
    expect(theirs.payload.body).toBe('');
    expect(theirs.shared).toEqual({ ownerDisplayName: 'Alice', access: 'view' });
  });
});

describe('nativeSaveNote', () => {
  it('persists a doc state that round-trips the body, plus search projection', async () => {
    native.noteSave.mockResolvedValue(undefined);
    await nativeSaveNote('n1', { title: 'T', body: 'hello world', tags: ['a'] });

    const [id, title, search, tagsJson, state] = native.noteSave.mock.calls[0];
    expect(id).toBe('n1');
    expect(title).toBe('T');
    expect(search).toBe('hello world\na');
    expect(JSON.parse(tagsJson)).toEqual(['a']);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Uint8Array.from(state as number[]));
    expect(doc.getText('content').toString()).toBe('hello world');
  });

  it('keeps one doc lineage across successive saves', async () => {
    native.noteSave.mockResolvedValue(undefined);
    await nativeSaveNote('n1', { title: '', body: 'first', tags: [] });
    await nativeSaveNote('n1', { title: '', body: 'second', tags: [] });
    const state = native.noteSave.mock.calls[1][4] as number[];
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Uint8Array.from(state));
    expect(doc.getText('content').toString()).toBe('second');
  });
});

describe('create/delete', () => {
  it('delegates to the core', async () => {
    native.noteCreate.mockResolvedValue(undefined);
    native.noteDelete.mockResolvedValue(undefined);
    await nativeCreateNote('n9');
    await nativeDeleteNote('n9');
    expect(native.noteCreate).toHaveBeenCalledWith('n9');
    expect(native.noteDelete).toHaveBeenCalledWith('n9');
  });
});
