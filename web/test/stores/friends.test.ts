import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Friend, FriendRequest } from '@notes/shared';

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

const friend = (over: Partial<Friend> = {}): Friend => ({ userId: 'u1', displayName: 'U1', publicKey: 'pk', online: false, ...over });
const request = (over: Partial<FriendRequest> = {}): FriendRequest => ({ id: 'r1', userId: 'u1', displayName: 'U1', direction: 'incoming', createdAt: 0, ...over });

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe('redeem', () => {
  it('reloads requests to reflect the new pending request', async () => {
    api.friendRedeem.mockResolvedValue(undefined);
    api.friendRequests.mockResolvedValue([request()]);
    const store = useFriendsStore();
    await store.redeem('token');
    expect(api.friendRedeem).toHaveBeenCalledWith('token');
    expect(store.requests).toHaveLength(1);
  });
});

describe('accept', () => {
  it('removes the request and adds the new friend', async () => {
    api.friendRequestAccept.mockResolvedValue(friend());
    const store = useFriendsStore();
    store.requests = [request({ id: 'r1' })];
    const f = await store.accept('r1');
    expect(f.userId).toBe('u1');
    expect(store.requests).toHaveLength(0);
    expect(store.friends.map((x) => x.userId)).toContain('u1');
  });
});

describe('decline', () => {
  it('drops the request without adding a friend', async () => {
    api.friendRequestDecline.mockResolvedValue(undefined);
    const store = useFriendsStore();
    store.requests = [request({ id: 'r1' }), request({ id: 'r2' })];
    await store.decline('r1');
    expect(store.requests.map((r) => r.id)).toEqual(['r2']);
    expect(store.friends).toHaveLength(0);
  });
});

describe('unfriend', () => {
  it('removes the friend locally', async () => {
    api.unfriend.mockResolvedValue(undefined);
    const store = useFriendsStore();
    store.friends = [friend({ userId: 'u1' }), friend({ userId: 'u2' })];
    await store.unfriend('u1');
    expect(store.friends.map((f) => f.userId)).toEqual(['u2']);
  });
});

describe('handleFrame', () => {
  it('friend-request inserts a new request and updates an existing one', () => {
    const store = useFriendsStore();
    store.handleFrame({ type: 'friend-request', request: request({ id: 'r1', displayName: 'First' }) });
    expect(store.requests).toHaveLength(1);
    store.handleFrame({ type: 'friend-request', request: request({ id: 'r1', displayName: 'Renamed' }) });
    expect(store.requests).toHaveLength(1);
    expect(store.requests[0]!.displayName).toBe('Renamed');
  });

  it('friend-accepted clears the matching request and adds the friend', () => {
    const store = useFriendsStore();
    store.requests = [request({ id: 'r1', userId: 'u1' })];
    store.handleFrame({ type: 'friend-accepted', friend: friend({ userId: 'u1' }) });
    expect(store.requests).toHaveLength(0);
    expect(store.friends.map((f) => f.userId)).toContain('u1');
  });

  it('presence flips a known friend online/offline and ignores unknown users', () => {
    const store = useFriendsStore();
    store.friends = [friend({ userId: 'u1', online: false })];
    store.handleFrame({ type: 'presence', userId: 'u1', online: true });
    expect(store.friends[0]!.online).toBe(true);
    store.handleFrame({ type: 'presence', userId: 'ghost', online: true });
    expect(store.friends).toHaveLength(1);
  });
});
