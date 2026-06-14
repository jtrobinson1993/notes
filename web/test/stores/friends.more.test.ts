import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Friend, FriendInvite, FriendRequest } from '@notes/shared';

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

import { useFriendsStore } from '../../src/stores/friends';

const friend = (id: string): Friend => ({ userId: id, displayName: id, publicKey: 'pk', online: false });
const request = (id: string): FriendRequest => ({ id, userId: 'u', displayName: 'U', direction: 'incoming', createdAt: 0 });
const invite = (id: string): FriendInvite => ({ id, token: `tok-${id}`, createdAt: 0, expiresAt: 1 });

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe('load', () => {
  it('fetches friends, requests, and invites in parallel into the store', async () => {
    api.friends.mockResolvedValue([friend('a'), friend('b')]);
    api.friendRequests.mockResolvedValue([request('r1')]);
    api.friendInvites.mockResolvedValue([invite('i1')]);
    const store = useFriendsStore();
    await store.load();
    expect(store.friends.map((f) => f.userId)).toEqual(['a', 'b']);
    expect(store.requests.map((r) => r.id)).toEqual(['r1']);
    expect(store.invites.map((i) => i.id)).toEqual(['i1']);
  });
});

describe('invites', () => {
  it('createInvite prepends the new invite', async () => {
    api.friendInviteCreate.mockResolvedValue(invite('new'));
    const store = useFriendsStore();
    store.invites = [invite('old')];
    const created = await store.createInvite();
    expect(created.id).toBe('new');
    expect(store.invites.map((i) => i.id)).toEqual(['new', 'old']);
  });

  it('deleteInvite removes it from the store', async () => {
    api.friendInviteDelete.mockResolvedValue(undefined);
    const store = useFriendsStore();
    store.invites = [invite('a'), invite('b')];
    await store.deleteInvite('a');
    expect(api.friendInviteDelete).toHaveBeenCalledWith('a');
    expect(store.invites.map((i) => i.id)).toEqual(['b']);
  });
});

describe('handleFrame ignores unrelated frames', () => {
  it('does nothing for a non-friends frame type', () => {
    const store = useFriendsStore();
    store.friends = [friend('a')];
    store.handleFrame({ type: 'message', message: {} as any });
    expect(store.friends.map((f) => f.userId)).toEqual(['a']); // unchanged
  });
});
