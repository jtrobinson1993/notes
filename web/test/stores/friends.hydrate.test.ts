import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Friend } from '@notes/shared';

const api = vi.hoisted(() => ({
  friends: vi.fn(),
  friendRequests: vi.fn(),
  friendInvites: vi.fn(),
  friendInviteCreate: vi.fn(),
  friendInviteDelete: vi.fn(),
  friendRedeem: vi.fn(),
  friendRequestAccept: vi.fn(),
  friendRequestDecline: vi.fn(),
  unfriend: vi.fn(),
}));
vi.mock('../../src/lib/api', () => ({ api }));

const profile = vi.hoisted(() => ({
  hydrate: vi.fn(),
  displayNameFor: vi.fn(),
}));
vi.mock('../../src/stores/profile', () => ({ useProfileStore: () => profile }));

import { useFriendsStore } from '../../src/stores/friends';

const friend = (over: Partial<Friend> = {}): Friend => ({ userId: 'u1', displayName: 'Word#1234', publicKey: 'pk', online: false, ...over });

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  profile.hydrate.mockResolvedValue(undefined);
});

describe('hydrateNames', () => {
  it('overlays the decrypted real name only when it differs from the current handle', async () => {
    const store = useFriendsStore();
    store.friends = [
      friend({ userId: 'a', displayName: 'Word#0001' }), // gets a real name -> overlay
      friend({ userId: 'b', displayName: 'Word#0002' }), // no real name -> keep handle
      friend({ userId: 'c', displayName: 'Carol' }), //      real name equals current -> no-op
    ];
    profile.displayNameFor.mockImplementation((id: string) =>
      id === 'a' ? 'Alice' : id === 'c' ? 'Carol' : null,
    );

    await store.hydrateNames();

    expect(profile.hydrate).toHaveBeenCalledWith(['a', 'b', 'c']);
    expect(store.friends.map((f) => f.displayName)).toEqual(['Alice', 'Word#0002', 'Carol']);
  });

  it('load() triggers a name hydration pass for the fetched friends', async () => {
    api.friends.mockResolvedValue([friend({ userId: 'a', displayName: 'Word#0001' })]);
    api.friendRequests.mockResolvedValue([]);
    api.friendInvites.mockResolvedValue([]);
    profile.displayNameFor.mockReturnValue('Alice');

    const store = useFriendsStore();
    await store.load();
    // load() fires hydrateNames() as void; await a microtask turn so it settles.
    await Promise.resolve();
    await Promise.resolve();

    expect(profile.hydrate).toHaveBeenCalledWith(['a']);
    expect(store.friends[0]!.displayName).toBe('Alice');
  });
});
