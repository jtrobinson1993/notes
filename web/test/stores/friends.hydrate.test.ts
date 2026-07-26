import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { FriendSummary } from '../../src/lib/native';

// The name-overlay invariant: a friend is shown by their public handle unless we
// hold their end-to-end-encrypted display name, which the core hands over in
// `display_name` (it never comes from a server-readable field).
const native = vi.hoisted(() => ({
  friendsList: vi.fn(async () => [] as FriendSummary[]),
  friendRemove: vi.fn(async () => {}),
}));
vi.mock('../../src/lib/native', () => native);
vi.mock('../../src/lib/nativeFriends', () => ({ createInvite: vi.fn(), redeemInvite: vi.fn() }));

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
});

describe('display names', () => {
  it('overlays the decrypted real name, and keeps the handle when there is none', async () => {
    native.friendsList.mockResolvedValue([
      summary({ contact_id: 'a', handle: 'Word#0001', display_name: 'Alice' }), // overlay
      summary({ contact_id: 'b', handle: 'Word#0002', display_name: null }), //     keep handle
      summary({ contact_id: 'c', handle: 'Word#0003', display_name: '   ' }), //    blank → handle
    ]);
    const store = useFriendsStore();
    await store.load();
    expect(store.friends.map((f) => f.displayName)).toEqual(['Alice', 'Word#0002', 'Word#0003']);
    // The handle stays available alongside the overlay (shown as the secondary id).
    expect(store.friends.map((f) => f.handle)).toEqual(['Word#0001', 'Word#0002', 'Word#0003']);
  });

  it('re-reads names on every load, so a renamed friend updates', async () => {
    const store = useFriendsStore();
    native.friendsList.mockResolvedValue([summary({ contact_id: 'a', display_name: null })]);
    await store.load();
    expect(store.friends[0]!.displayName).toBe('Wolf#0001');
    native.friendsList.mockResolvedValue([summary({ contact_id: 'a', display_name: 'Alice' })]);
    await store.load();
    expect(store.friends[0]!.displayName).toBe('Alice');
  });
});
