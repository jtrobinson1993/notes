import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { FriendSummary } from '../../src/lib/native';

// v8 D4b: friends come from the local core (no server-held requests, no
// presence) and invites are minted locally by the friend-flow orchestrator.
const native = vi.hoisted(() => ({
  friendsList: vi.fn(async () => [] as FriendSummary[]),
  friendRemove: vi.fn(async () => {}),
}));
vi.mock('../../src/lib/native', () => native);

const nativeFriends = vi.hoisted(() => ({
  createInvite: vi.fn(),
  redeemInvite: vi.fn(),
}));
vi.mock('../../src/lib/nativeFriends', () => nativeFriends);

import { useFriendsStore } from '../../src/stores/friends';

const summary = (over: Partial<FriendSummary> = {}): FriendSummary => ({
  contact_id: 'u1',
  handle: 'Wolf#0001',
  display_name: null,
  identity_pub: 'aWQ=',
  ...over,
});

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  native.friendsList.mockResolvedValue([]);
  native.friendRemove.mockResolvedValue(undefined);
});

describe('redeem', () => {
  it('redeems the pasted invite and reloads the friend list', async () => {
    nativeFriends.redeemInvite.mockResolvedValue({ inviterHandle: 'Wolf#0001', relayTs: 1 });
    native.friendsList.mockResolvedValue([summary()]);
    const store = useFriendsStore();
    await store.redeem('token');
    expect(nativeFriends.redeemInvite).toHaveBeenCalledWith('token');
    expect(store.friends.map((f) => f.userId)).toEqual(['u1']);
  });

  it('propagates a failed redeem without inventing a friend', async () => {
    nativeFriends.redeemInvite.mockRejectedValue(new Error('bad invite'));
    const store = useFriendsStore();
    await expect(store.redeem('nope')).rejects.toThrow('bad invite');
    expect(native.friendsList).not.toHaveBeenCalled();
    expect(store.friends).toEqual([]);
  });
});

describe('unfriend', () => {
  it('drops the friend in the core and locally', async () => {
    const store = useFriendsStore();
    native.friendsList.mockResolvedValue([summary({ contact_id: 'u1' }), summary({ contact_id: 'u2' })]);
    await store.load();
    await store.unfriend('u1');
    expect(native.friendRemove).toHaveBeenCalledWith('u1');
    expect(store.friends.map((f) => f.userId)).toEqual(['u2']);
  });

  it('keeps the friend locally when the core refuses to remove them', async () => {
    native.friendsList.mockResolvedValue([summary({ contact_id: 'u1' })]);
    native.friendRemove.mockRejectedValue(new Error('locked'));
    const store = useFriendsStore();
    await store.load();
    await expect(store.unfriend('u1')).rejects.toThrow('locked');
    expect(store.friends.map((f) => f.userId)).toEqual(['u1']);
  });
});

describe('reset', () => {
  it('drops the decrypted friend list and any minted invites (on lock)', async () => {
    nativeFriends.createInvite.mockResolvedValue({ invite: 'inv', expiresAt: 1 });
    native.friendsList.mockResolvedValue([summary()]);
    const store = useFriendsStore();
    await store.load();
    await store.createInvite();
    store.reset();
    expect(store.friends).toEqual([]);
    expect(store.invites).toEqual([]);
  });
});
