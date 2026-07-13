import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

// Native shell: there is no server and no legacy master key — the org blob
// (folder names + pins) belongs in the encrypted vault, never in plaintext
// localStorage.
const vault = vi.hoisted(() => new Map<string, string>());
const native = vi.hoisted(() => ({
  isNative: true,
  settingsGet: vi.fn(async (k: string) => vault.get(k) ?? null),
  settingsSet: vi.fn(async (k: string, v: string) => {
    vault.set(k, v);
  }),
}));
vi.mock('../../src/lib/native', () => native);

const api = vi.hoisted(() => ({
  settingGet: vi.fn().mockResolvedValue(null),
  settingPut: vi.fn().mockResolvedValue({ updatedAt: 0 }),
}));
vi.mock('../../src/lib/api', () => ({ api }));
vi.mock('../../src/stores/session', () => ({ useSessionStore: () => ({ mk: null }) }));

import { useOrgStore } from '../../src/stores/organization';

beforeEach(() => {
  setActivePinia(createPinia());
  vault.clear();
  localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  useOrgStore().$dispose(); // cancel the debounced write (see organization.test.ts)
});

describe('organization store — native (vault-backed) persistence', () => {
  it('writes the blob to the encrypted vault and reloads it, touching neither the server nor localStorage', async () => {
    const org1 = useOrgStore();
    const folder = org1.createChatFolder('dm:alice', 'Reference');
    org1.pin('dm:alice', 'note', 'n1');
    org1.setChatItemFolder('dm:alice', 'n:n1', folder);

    await vi.waitFor(() => expect(native.settingsSet).toHaveBeenCalled(), { timeout: 3000 });
    expect(api.settingPut).not.toHaveBeenCalled(); // no server in the native shell
    // Folder names are as sensitive as tag names: nothing in the clear on disk.
    expect(localStorage.getItem('notes:org')).toBeNull();
    expect(vault.get('notes-org')).toContain('Reference'); // SQLCipher encrypts at rest

    // A fresh store (new launch) reads it back out of the vault.
    setActivePinia(createPinia());
    const org2 = useOrgStore();
    expect(org2.pinsFor('dm:alice')).toEqual([]); // nothing cached in the clear
    await org2.load();
    expect(org2.chatChildFolders('dm:alice', null).map((f) => f.name)).toEqual(['Reference']);
    expect(org2.isPinned('dm:alice', 'note', 'n1')).toBe(true);
    expect(org2.chatItemFolderOf('dm:alice', 'n:n1')).toBe(folder);
  });
});
