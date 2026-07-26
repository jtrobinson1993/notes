import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { FriendSummary } from '../../src/lib/native';

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

const summary = (id: string, over: Partial<FriendSummary> = {}): FriendSummary => ({
  contact_id: id,
  handle: `Wolf#${id}`,
  display_name: null,
  identity_pub: 'aWQ=',
  ...over,
});

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  native.friendsList.mockResolvedValue([]);
});

describe('load', () => {
  it('maps the core friend list into store entries', async () => {
    native.friendsList.mockResolvedValue([summary('a'), summary('b')]);
    const store = useFriendsStore();
    await store.load();
    expect(store.friends.map((f) => f.userId)).toEqual(['a', 'b']);
    expect(store.friends.map((f) => f.handle)).toEqual(['Wolf#a', 'Wolf#b']);
  });

  it('replaces the previous list rather than appending to it', async () => {
    const store = useFriendsStore();
    native.friendsList.mockResolvedValue([summary('a'), summary('b')]);
    await store.load();
    native.friendsList.mockResolvedValue([summary('b')]); // 'a' unfriended elsewhere
    await store.load();
    expect(store.friends.map((f) => f.userId)).toEqual(['b']);
  });
});

describe('invites', () => {
  it('createInvite prepends the minted invite (token comes from the core)', async () => {
    nativeFriends.createInvite.mockResolvedValue({ invite: 'tok-new', expiresAt: 42 });
    const store = useFriendsStore();
    const created = await store.createInvite();
    expect(created.token).toBe('tok-new');
    expect(created.expiresAt).toBe(42);

    nativeFriends.createInvite.mockResolvedValue({ invite: 'tok-newer', expiresAt: 43 });
    await store.createInvite();
    expect(store.invites.map((i) => i.token)).toEqual(['tok-newer', 'tok-new']);
  });

  it('deleteInvite removes it from the local list', async () => {
    nativeFriends.createInvite.mockResolvedValueOnce({ invite: 'tok-a', expiresAt: 1 });
    nativeFriends.createInvite.mockResolvedValueOnce({ invite: 'tok-b', expiresAt: 1 });
    const store = useFriendsStore();
    const a = await store.createInvite();
    await store.createInvite();
    store.deleteInvite(a.id);
    expect(store.invites.map((i) => i.token)).toEqual(['tok-b']);
  });
});
