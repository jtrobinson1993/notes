import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { generateKeyPair, generateMasterKey } from '../../src/lib/crypto';
import { b64 } from '../../src/lib/b64';
import { encryptProfile, generateProfileKey, sealProfileKey } from '../../src/lib/profileCrypto';

const api = vi.hoisted(() => ({
  profileGet: vi.fn(),
  profileSet: vi.fn().mockResolvedValue({}),
  profileDataGet: vi.fn(),
  profileDataSet: vi.fn(),
  profileKeysAdd: vi.fn(),
  profileVisibilitySet: vi.fn(),
  userProfileGet: vi.fn(),
}));
vi.mock('../../src/lib/api', () => ({ api }));

// A stable master key + keypair for "me" across the test (closure-captured).
const myKp = generateKeyPair();
const myMk = generateMasterKey();
vi.mock('../../src/stores/session', () => ({
  useSessionStore: () => ({ user: { id: 'me' }, mk: myMk, getKeyPair: async () => myKp }),
}));

// Friends + conversations are injected per-test via these mutable holders.
const holder: { friends: { userId: string; publicKey: string | null }[]; conversations: any[] } = {
  friends: [],
  conversations: [],
};
vi.mock('../../src/stores/friends', () => ({ useFriendsStore: () => ({ friends: holder.friends }) }));
vi.mock('../../src/stores/chat', () => ({ useChatStore: () => ({ conversations: holder.conversations }) }));

import { useProfileStore } from '../../src/stores/profile';

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  holder.friends = [];
  holder.conversations = [];
  // displayName === handle ⇒ no legacy name to migrate into the encrypted blob.
  api.profileGet.mockResolvedValue({ displayName: 'Wolf#0001', handle: 'Wolf#0001', nameColor: null, friendsOnly: true, linkPreviews: false });
  api.profileDataGet.mockResolvedValue({ profile: null });
  // The server echoes back the epoch it was sent.
  api.profileDataSet.mockImplementation(async (body: { epoch: number }) => ({ ok: true, epoch: body.epoch }));
  api.profileVisibilitySet.mockImplementation(async (friendsOnly: boolean) => ({
    displayName: 'Me',
    nameColor: null,
    friendsOnly,
  }));
});

const friendKp = generateKeyPair();

describe('profile store', () => {
  it('save() seals the profile key to each friend and stores the blob', async () => {
    holder.friends = [{ userId: 'f', publicKey: b64(friendKp.publicKey) }];
    const store = useProfileStore();
    await store.load();
    await store.save({ bio: 'hello' });

    expect(api.profileDataSet).toHaveBeenCalledTimes(1);
    const body = api.profileDataSet.mock.calls[0]![0];
    expect(body.keys.map((k: any) => k.recipientId)).toEqual(['f']);
    expect(body.ciphertext).toBeTruthy();
    expect(body.ownerWrappedKey).toMatchObject({ salt: expect.any(String) });
  });

  it('load() exposes my own handle + name color (for my own profile card)', async () => {
    api.profileGet.mockResolvedValueOnce({ displayName: 'Wolf#0001', handle: 'Wolf#0001', nameColor: 'blue', friendsOnly: true, linkPreviews: false });
    const store = useProfileStore();
    await store.load();
    expect(store.myHandle).toBe('Wolf#0001');
    expect(store.myNameColor).toBe('blue');
    store.reset();
    expect(store.myNameColor).toBeNull();
  });

  it('round-trips my own profile: save then reload decrypts via the MK-wrapped key', async () => {
    const store = useProfileStore();
    await store.load();
    await store.save({ bio: 'my secret bio' });
    const body = api.profileDataSet.mock.calls[0]![0];

    // Simulate a fresh device: clear in-memory key, then load the stored blob.
    store.reset();
    api.profileDataGet.mockResolvedValue({
      profile: { ciphertext: body.ciphertext, iv: body.iv, epoch: body.epoch, ownerWrappedKey: body.ownerWrappedKey },
    });
    await store.load();
    expect(store.myData.bio).toBe('my secret bio');
  });

  it('updateProfileData keeps the encrypted display name when editing avatar/bio', async () => {
    const store = useProfileStore();
    await store.load();
    await store.save({ displayName: 'Real Name', bio: 'old bio' });

    // Editing the avatar (and clearing the bio) must not drop the display name —
    // otherwise a blank name gets re-distributed to every contact, who then fall
    // back to showing the bare handle even after a refresh.
    await store.updateProfileData({ avatar: 'data:image/webp;base64,QQ', bio: undefined });
    expect(store.myData.displayName).toBe('Real Name');
    expect(store.myData.avatar).toBe('data:image/webp;base64,QQ');
    expect(store.myData.bio).toBeUndefined();

    // The persisted + redistributed blob still carries the name (decrypt on reload).
    const body = api.profileDataSet.mock.calls.at(-1)![0];
    store.reset();
    api.profileDataGet.mockResolvedValue({
      profile: { ciphertext: body.ciphertext, iv: body.iv, epoch: body.epoch, ownerWrappedKey: body.ownerWrappedKey },
    });
    await store.load();
    expect(store.myData.displayName).toBe('Real Name');
  });

  it('migrates a legacy plaintext display name into the encrypted profile, then clears it', async () => {
    api.profileGet.mockResolvedValueOnce({ displayName: 'Real Name', handle: 'Wolf#0001', nameColor: null, friendsOnly: true, linkPreviews: false });
    const store = useProfileStore();
    await store.load();
    // The real name was encrypted into the profile blob…
    expect(api.profileDataSet).toHaveBeenCalled();
    expect(store.myData.displayName).toBe('Real Name');
    // …and the server's plaintext copy was cleared.
    expect(api.profileSet).toHaveBeenCalledWith({ displayName: null });
  });

  it('does not migrate when the display name already equals the handle', async () => {
    const store = useProfileStore();
    await store.load(); // beforeEach mock: displayName === handle
    expect(api.profileDataSet).not.toHaveBeenCalled();
    expect(api.profileSet).not.toHaveBeenCalled();
  });

  it('fetch() decrypts a contact profile sealed to my key', async () => {
    const key = generateProfileKey();
    const { ciphertext, iv } = await encryptProfile(key, { bio: 'their bio', avatar: 'data:image/webp;base64,QQ' });
    const sealedKey = await sealProfileKey(myKp.publicKey, key);
    api.userProfileGet.mockResolvedValue({
      userId: 'them',
      displayName: 'Them',
      nameColor: 'blue',
      encrypted: { ciphertext, iv, epoch: 0, sealedKey },
    });

    const store = useProfileStore();
    const entry = await store.fetch('them');
    expect(entry.displayName).toBe('Them');
    expect(entry.data).toEqual({ bio: 'their bio', avatar: 'data:image/webp;base64,QQ' });
    // Cached: a second fetch doesn't hit the API again.
    await store.fetch('them');
    expect(api.userProfileGet).toHaveBeenCalledTimes(1);
  });

  it('fetch() yields null data when there is no sealed key for me', async () => {
    api.userProfileGet.mockResolvedValue({ userId: 'them', displayName: 'Them', nameColor: null, encrypted: null });
    const store = useProfileStore();
    const entry = await store.fetch('them');
    expect(entry.data).toBeNull();
  });

  it('visibility off widens recipients to group co-members and redistributes', async () => {
    holder.friends = [{ userId: 'f', publicKey: b64(friendKp.publicKey) }];
    holder.conversations = [
      { members: [{ userId: 'me', publicKey: null }, { userId: 'x', publicKey: b64(generateKeyPair().publicKey) }] },
    ];
    const store = useProfileStore();
    await store.load();
    await store.save({ bio: 'hi' }); // friends-only → only 'f'
    expect(api.profileDataSet.mock.calls[0]![0].keys.map((k: any) => k.recipientId)).toEqual(['f']);

    await store.setVisibility(false); // widens → re-persist with 'f' + co-member 'x'
    const last = api.profileDataSet.mock.calls.at(-1)![0];
    expect(last.keys.map((k: any) => k.recipientId).sort()).toEqual(['f', 'x']);
  });

  it('rotate() bumps the epoch and re-persists', async () => {
    holder.friends = [{ userId: 'f', publicKey: b64(friendKp.publicKey) }];
    const store = useProfileStore();
    await store.load();
    await store.save({ bio: 'hi' }); // establishes a profile key at epoch 0
    await store.rotate();
    const last = api.profileDataSet.mock.calls.at(-1)![0];
    expect(last.epoch).toBe(1);
  });
});
