import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

// An in-memory settings store standing in for the server, so we can exercise the
// real master-key encrypt → store → decrypt round-trip.
const store = vi.hoisted(() => new Map<string, string>());
const api = vi.hoisted(() => ({
  settingGet: vi.fn(async (k: string) => (store.has(k) ? { data: store.get(k)!, updatedAt: 0 } : null)),
  settingPut: vi.fn(async (k: string, data: string) => {
    store.set(k, data);
    return { updatedAt: 0 };
  }),
}));
vi.mock('../../src/lib/api', () => ({ api }));
vi.mock('../../src/stores/session', () => ({
  useSessionStore: () => ({ mk: new Uint8Array(32).fill(7) }),
}));

import { useOrgStore } from '../../src/stores/organization';

beforeEach(() => {
  setActivePinia(createPinia());
  store.clear();
  localStorage.clear();
  vi.clearAllMocks();
});

describe('organization store — folders', () => {
  it('creates, renames, and orders folders', () => {
    const org = useOrgStore();
    const a = org.createFolder('Work');
    const b = org.createFolder('Personal');
    expect(org.sortedFolders.map((f) => f.name)).toEqual(['Work', 'Personal']);
    org.renameFolder(a, 'Job');
    expect(org.sortedFolders.find((f) => f.id === a)!.name).toBe('Job');
    expect(b).not.toBe(a);
  });

  it('assigns notes to a folder and reports membership', () => {
    const org = useOrgStore();
    const f = org.createFolder('Work');
    org.setNoteFolder('n1', f);
    expect(org.folderOf('n1')).toBe(f);
    org.setNoteFolder('n1', null);
    expect(org.folderOf('n1')).toBeNull();
  });

  it('deleting a folder unfiles its notes and removes its pins', () => {
    const org = useOrgStore();
    const f = org.createFolder('Work');
    org.setNoteFolder('n1', f);
    org.pin('conv1', 'folder', f);
    org.deleteFolder(f);
    expect(org.sortedFolders).toHaveLength(0);
    expect(org.folderOf('n1')).toBeNull();
    expect(org.isPinned('conv1', 'folder', f)).toBe(false);
  });
});

describe('organization store — nesting', () => {
  it('creates subfolders and reports children + descendants', () => {
    const org = useOrgStore();
    const work = org.createFolder('Work');
    const proj = org.createFolder('Project', work);
    const sub = org.createFolder('Subtask', proj);
    org.createFolder('Personal'); // a root sibling
    expect(org.childFolders(null).map((f) => f.name)).toEqual(['Work', 'Personal']);
    expect(org.childFolders(work).map((f) => f.name)).toEqual(['Project']);
    expect(org.descendantFolderIds(work).sort()).toEqual([work, proj, sub].sort());
  });

  it('re-parents a folder but refuses to create a cycle', () => {
    const org = useOrgStore();
    const a = org.createFolder('A');
    const b = org.createFolder('B', a); // B under A
    org.setFolderParent(a, b); // would make a cycle → ignored
    expect(org.childFolders(null).map((f) => f.name)).toEqual(['A']);
    const c = org.createFolder('C');
    org.setFolderParent(a, c); // valid move
    expect(org.childFolders(c).map((f) => f.name)).toEqual(['A']);
  });

  it('deleting a folder lifts its children to the grandparent', () => {
    const org = useOrgStore();
    const root = org.createFolder('Root');
    const mid = org.createFolder('Mid', root);
    const leaf = org.createFolder('Leaf', mid);
    org.deleteFolder(mid);
    // Leaf moves up under Root; Mid is gone.
    expect(org.folders.find((f) => f.id === mid)).toBeUndefined();
    expect(org.folders.find((f) => f.id === leaf)!.parentId).toBe(root);
  });
});

describe('organization store — pins', () => {
  it('pins/unpins notes and folders per conversation (idempotent)', () => {
    const org = useOrgStore();
    org.pin('conv1', 'note', 'n1');
    org.pin('conv1', 'note', 'n1'); // idempotent
    org.pin('conv1', 'folder', 'f1');
    org.pin('conv2', 'note', 'n1');
    expect(org.pinsFor('conv1')).toHaveLength(2);
    expect(org.pinsFor('conv2')).toHaveLength(1);
    org.unpin('conv1', 'note', 'n1');
    expect(org.isPinned('conv1', 'note', 'n1')).toBe(false);
    expect(org.isPinned('conv2', 'note', 'n1')).toBe(true); // other conv untouched
  });

  it('forgetNote drops the note from its folder and every pin', () => {
    const org = useOrgStore();
    const f = org.createFolder('Work');
    org.setNoteFolder('n1', f);
    org.pin('conv1', 'note', 'n1');
    org.pin('conv2', 'note', 'n1');
    org.forgetNote('n1');
    expect(org.folderOf('n1')).toBeNull();
    expect(org.isPinned('conv1', 'note', 'n1')).toBe(false);
    expect(org.isPinned('conv2', 'note', 'n1')).toBe(false);
  });
});

describe('organization store — encrypted persistence', () => {
  it('round-trips through the master-key-encrypted settings blob', async () => {
    const org1 = useOrgStore();
    const f = org1.createFolder('Work');
    org1.setNoteFolder('n1', f);
    org1.pin('conv1', 'note', 'n1');
    // Flush the debounced push.
    await vi.waitFor(() => expect(api.settingPut).toHaveBeenCalled());

    // The persisted blob is ciphertext, not plaintext folder names.
    expect(store.get('notes-org')).not.toContain('Work');

    // A fresh store loads + decrypts it.
    localStorage.clear();
    setActivePinia(createPinia());
    const org2 = useOrgStore();
    await org2.load();
    expect(org2.sortedFolders.map((f) => f.name)).toEqual(['Work']);
    expect(org2.folderOf('n1')).toBe(f);
    expect(org2.isPinned('conv1', 'note', 'n1')).toBe(true);
  });
});
