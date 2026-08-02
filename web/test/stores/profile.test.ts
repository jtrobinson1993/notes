import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

// My identity lives in the encrypted vault: the public handle under
// `identity.handle`, the E2EE display name under `profile.displayName`. There is
// no server-readable name (see the handle invariant in CLAUDE.md).
const vault = vi.hoisted(() => new Map<string, string>());
const native = vi.hoisted(() => ({
  settingsGet: vi.fn(async (k: string) => vault.get(k) ?? null),
  settingsSet: vi.fn(async (k: string, v: string) => {
    vault.set(k, v);
  }),
}));
vi.mock('../../src/lib/native', () => native);

import { useProfileStore } from '../../src/stores/profile';

beforeEach(() => {
  setActivePinia(createPinia());
  vault.clear();
  vi.clearAllMocks();
  vault.set('identity.handle', 'Wolf#0001');
});

describe('profile store — my identity', () => {
  it('load() reads my handle and encrypted display name out of the vault', async () => {
    vault.set('profile.displayName', 'Real Name');
    const store = useProfileStore();
    await store.load();
    expect(store.myHandle).toBe('Wolf#0001');
    expect(store.myData.displayName).toBe('Real Name');
    expect(store.myDisplayName).toBe('Real Name');
    expect(store.loaded).toBe(true);
  });

  it('falls back to the public handle when no display name is set', async () => {
    const store = useProfileStore();
    await store.load();
    expect(store.myData.displayName).toBeUndefined();
    expect(store.myDisplayName).toBe('Wolf#0001');
  });

  it('falls back to the handle when the stored name is only whitespace', async () => {
    vault.set('profile.displayName', '   ');
    const store = useProfileStore();
    await store.load();
    expect(store.myDisplayName).toBe('Wolf#0001');
  });
});

describe('profile store — saving', () => {
  it('save() persists the trimmed display name into the vault', async () => {
    const store = useProfileStore();
    await store.load();
    await store.save({ displayName: '  Real Name  ', bio: 'hello' });
    expect(native.settingsSet).toHaveBeenCalledWith('profile.displayName', 'Real Name');
    expect(store.myData.bio).toBe('hello');
  });

  it('save() clears the stored name when it is emptied', async () => {
    vault.set('profile.displayName', 'Real Name');
    const store = useProfileStore();
    await store.load();
    await store.save({});
    expect(native.settingsSet).toHaveBeenCalledWith('profile.displayName', '');
    expect(store.myDisplayName).toBe('Wolf#0001');
  });

  it('updateProfileData keeps the display name when editing avatar/bio', async () => {
    const store = useProfileStore();
    await store.load();
    await store.save({ displayName: 'Real Name', bio: 'old bio' });

    // Editing the avatar (and clearing the bio) must not drop the display name —
    // otherwise a blank name gets persisted and every contact falls back to
    // showing the bare handle.
    await store.updateProfileData({ avatar: 'data:image/webp;base64,QQ', bio: undefined });
    expect(store.myData.displayName).toBe('Real Name');
    expect(store.myData.avatar).toBe('data:image/webp;base64,QQ');
    expect(store.myData.bio).toBeUndefined();

    // And it survives a reload from the vault.
    store.reset();
    await store.load();
    expect(store.myData.displayName).toBe('Real Name');
  });
});

describe('profile store — contact cache', () => {
  it('serves the decrypted real name only when one is cached', async () => {
    const store = useProfileStore();
    store.cache = {
      known: { displayName: 'Alice', handle: 'Word#0002', nameColor: null, data: { displayName: 'Alice', avatar: 'a.webp' } },
      bare: { displayName: 'Word#0003', handle: 'Word#0003', nameColor: null, data: null },
    };
    expect(store.displayNameFor('known')).toBe('Alice');
    expect(store.displayNameFor('bare')).toBeNull();
    expect(store.displayNameFor('stranger')).toBeNull(); // never invents a name
    expect(store.avatarFor('known')).toBe('a.webp');
    expect(store.avatarFor('stranger')).toBeUndefined();

    store.invalidate('known');
    expect(store.displayNameFor('known')).toBeNull();
  });

  it('reset() drops my identity and every cached contact profile (on lock)', async () => {
    vault.set('profile.displayName', 'Real Name');
    const store = useProfileStore();
    await store.load();
    store.cache = { u: { displayName: 'Alice', handle: 'Word#0002', nameColor: null, data: { displayName: 'Alice' } } };

    store.reset();
    expect(store.myHandle).toBe('');
    expect(store.myData).toEqual({});
    expect(store.myNameColor).toBeNull();
    expect(store.loaded).toBe(false);
    expect(store.cache).toEqual({});
    expect(store.displayNameFor('u')).toBeNull();
  });
});
