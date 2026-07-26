import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { DecryptedNote } from '../../src/stores/notes';

// Notes are local-first: the encrypted vault (via the Rust core) is the source of
// truth, so the store's job is the in-memory projection + the write-through to
// `nativeNotes`. Server sync/sharing land in a later phase.
const nativeNotes = vi.hoisted(() => ({
  nativeLoadNotes: vi.fn(async () => [] as DecryptedNote[]),
  nativeCreateNote: vi.fn(async () => {}),
  nativeSaveNote: vi.fn(async () => {}),
  nativeDeleteNote: vi.fn(async () => {}),
  resetNativeNotes: vi.fn(),
}));
vi.mock('../../src/lib/nativeNotes', () => nativeNotes);

const org = vi.hoisted(() => ({ forgetNote: vi.fn() }));
vi.mock('../../src/stores/organization', () => ({ useOrgStore: () => org }));

import { useNotesStore } from '../../src/stores/notes';

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  nativeNotes.nativeLoadNotes.mockResolvedValue([]);
});

const note = (id: string, over: Partial<DecryptedNote> = {}): DecryptedNote => ({
  id,
  payload: { title: id, body: '', tags: [] },
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('notes store — local-first load', () => {
  it('hydrates from the local store and marks itself loaded', async () => {
    nativeNotes.nativeLoadNotes.mockResolvedValue([note('n1'), note('n2')]);
    const store = useNotesStore();
    expect(store.loaded).toBe(false);
    await store.loadFromCache();
    expect(store.loaded).toBe(true);
    expect([...store.notes.keys()].sort()).toEqual(['n1', 'n2']);
  });

  it('sorts by recency and collects the tag set', async () => {
    nativeNotes.nativeLoadNotes.mockResolvedValue([
      note('old', { updatedAt: 1, payload: { title: 'old', body: '', tags: ['b', 'a'] } }),
      note('new', { updatedAt: 5, payload: { title: 'new', body: '', tags: ['a'] } }),
    ]);
    const store = useNotesStore();
    await store.loadFromCache();
    expect(store.sorted.map((n) => n.id)).toEqual(['new', 'old']);
    expect(store.allTags).toEqual(['a', 'b']); // de-duplicated + sorted
  });
});

describe('notes store — save', () => {
  it('writes through to the local store and stamps updatedAt', async () => {
    const store = useNotesStore();
    await store.save('n1', { title: 'hello', body: 'body', tags: ['x'] });
    expect(nativeNotes.nativeSaveNote).toHaveBeenCalledWith('n1', {
      title: 'hello', body: 'body', tags: ['x'],
    });
    const saved = store.notes.get('n1')!;
    expect(saved.payload.title).toBe('hello');
    expect(saved.updatedAt).toBeGreaterThan(0);
  });

  it('keeps the original createdAt when overwriting an existing note', async () => {
    nativeNotes.nativeLoadNotes.mockResolvedValue([note('n1', { createdAt: 111, updatedAt: 111 })]);
    const store = useNotesStore();
    await store.loadFromCache();
    await store.save('n1', { title: 'edited', body: '', tags: [] });
    expect(store.notes.get('n1')!.createdAt).toBe(111);
  });
});

describe('notes store — create', () => {
  it('creates the note in the core before writing its first payload', async () => {
    const order: string[] = [];
    nativeNotes.nativeCreateNote.mockImplementation(async () => void order.push('create'));
    nativeNotes.nativeSaveNote.mockImplementation(async () => void order.push('save'));
    const store = useNotesStore();
    const id = await store.create({ title: 'Draft' });
    expect(order).toEqual(['create', 'save']);
    expect(nativeNotes.nativeCreateNote).toHaveBeenCalledWith(id);
    expect(store.notes.get(id)!.payload).toEqual({ title: 'Draft', body: '', tags: [] });
  });
});

describe('notes store — remove', () => {
  it('deletes locally, forgets the organization entries, and deletes in the core', async () => {
    nativeNotes.nativeLoadNotes.mockResolvedValue([note('n1')]);
    const store = useNotesStore();
    await store.loadFromCache();
    await store.remove('n1');
    expect(store.notes.has('n1')).toBe(false);
    expect(org.forgetNote).toHaveBeenCalledWith('n1');
    expect(nativeNotes.nativeDeleteNote).toHaveBeenCalledWith('n1');
  });
});

describe('notes store — reset', () => {
  it('drops every decrypted note (plaintext must not outlive the key)', async () => {
    nativeNotes.nativeLoadNotes.mockResolvedValue([note('n1')]);
    const store = useNotesStore();
    await store.loadFromCache();
    store.reset();
    expect(store.notes.size).toBe(0);
    expect(store.sorted).toEqual([]);
    expect(store.loaded).toBe(false);
    // The Y.Doc cache in the native layer holds plaintext too — it must be cleared.
    expect(nativeNotes.resetNativeNotes).toHaveBeenCalled();
  });
});
