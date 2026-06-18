import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { SealedKey, SharedNoteRecord } from '@notes/shared';
import { generateKeyPair, decryptSharedNotePayload } from '../../src/lib/crypto';
import { b64 } from '../../src/lib/b64';

// API + cache + session + org are mocked; crypto is real (Node WebCrypto), so the
// rotation re-seal is verified end-to-end.
const api = vi.hoisted(() => ({
  notes: vi.fn().mockResolvedValue({ notes: [], serverTime: 0 }),
  sharedNotes: vi.fn().mockResolvedValue([]),
  notePut: vi.fn().mockResolvedValue({ updatedAt: 1 }),
  noteDelete: vi.fn().mockResolvedValue({ ok: true }),
  shareNote: vi.fn().mockResolvedValue({ ok: true }),
  unshareNote: vi.fn().mockResolvedValue({ ok: true }),
  noteShares: vi.fn().mockResolvedValue([]),
  members: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/lib/api', () => ({ api, ApiError: class extends Error {} }));
vi.mock('../../src/lib/idb', () => ({
  ensureCacheOwner: vi.fn(), getCacheMeta: vi.fn(), getCachedNotes: vi.fn().mockResolvedValue([]),
  getCachedShared: vi.fn().mockResolvedValue([]), getOutbox: vi.fn().mockResolvedValue([]),
  putCachedNotes: vi.fn(), putOutbox: vi.fn(), removeCachedNote: vi.fn(), removeOutbox: vi.fn(),
  replaceCachedShared: vi.fn(), setCacheMeta: vi.fn(),
}));
const mk = new Uint8Array(32).fill(9);
vi.mock('../../src/stores/session', () => ({
  useSessionStore: () => ({ mk, user: { id: 'me' }, getKeyPair: async () => generateKeyPair() }),
}));
vi.mock('../../src/stores/organization', () => ({
  useOrgStore: () => ({ forgetNote: vi.fn(), descendantFolderIds: (id: string) => [id], folderOf: () => 'fold' }),
}));

import { useNotesStore } from '../../src/stores/notes';

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  api.notePut.mockResolvedValue({ updatedAt: 1 });
});

describe('notes store — revokeShare (rotate + re-seal)', () => {
  it('rotates the note key, re-seals to the remaining recipient, and unshares the revoked one', async () => {
    const store = useNotesStore();
    await store.save('n1', { title: 'secret', body: 'body', tags: [] });
    const firstWrapped = JSON.stringify(api.notePut.mock.calls[0]![1].wrappedKey);

    const friend = generateKeyPair();
    api.noteShares.mockResolvedValue([
      { noteId: 'n1', recipientId: 'F', recipientDisplayName: 'F', access: 'read', createdAt: 0 },
      { noteId: 'n1', recipientId: 'R', recipientDisplayName: 'R', access: 'read', createdAt: 0 },
    ]);
    api.members.mockResolvedValue([{ id: 'F', displayName: 'F', publicKey: b64(friend.publicKey) }]);

    await store.revokeShare('n1', 'R');

    // Revoked recipient's seal removed.
    expect(api.unshareNote).toHaveBeenCalledWith('n1', 'R');
    // The note was re-encrypted under a fresh key (wrappedKey changed).
    const rotated = api.notePut.mock.calls.at(-1)![1];
    expect(JSON.stringify(rotated.wrappedKey)).not.toBe(firstWrapped);
    // Only the remaining recipient (F) got re-sealed — not R.
    const reseals = api.shareNote.mock.calls.filter((c) => c[0] === 'n1');
    expect(reseals.map((c) => c[1])).toEqual(['F']);

    // F can decrypt the rotated note with the re-sealed key → proves the rotation
    // is sound and bound to the new ciphertext.
    const sealed = reseals[0]![2] as SealedKey;
    const record: SharedNoteRecord = {
      id: 'n1', ciphertext: rotated.ciphertext, iv: rotated.iv, sealedKey: sealed,
      ownerDisplayName: 'Me', access: 'read', createdAt: 0, updatedAt: 1,
    };
    const { payload } = await decryptSharedNotePayload(friend.privateKey, friend.publicKey, record);
    expect(payload.title).toBe('secret');
  });
});

describe('notes store — shareFolder (recursive snapshot)', () => {
  it('shares each owned note in the folder with every recipient', async () => {
    const store = useNotesStore();
    await store.save('n1', { title: 'a', body: '', tags: [] });
    await store.save('n2', { title: 'b', body: '', tags: [] });
    const friend = generateKeyPair();
    await store.shareFolder('fold', [{ id: 'F', publicKey: b64(friend.publicKey) }], 'read');
    // Both owned notes shared with F.
    const shared = api.shareNote.mock.calls.filter((c) => c[1] === 'F').map((c) => c[0]).sort();
    expect(shared).toEqual(['n1', 'n2']);
  });
});
