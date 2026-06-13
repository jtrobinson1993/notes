import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Friend, FriendInvite, FriendRequest, ServerFrame } from '@notes/shared';
import { api } from '../lib/api';

export const useFriendsStore = defineStore('friends', () => {
  const friends = ref<Friend[]>([]);
  const requests = ref<FriendRequest[]>([]);
  const invites = ref<FriendInvite[]>([]);

  async function load(): Promise<void> {
    const [f, r, i] = await Promise.all([api.friends(), api.friendRequests(), api.friendInvites()]);
    friends.value = f;
    requests.value = r;
    invites.value = i;
  }

  async function createInvite(): Promise<FriendInvite> {
    const invite = await api.friendInviteCreate();
    invites.value = [invite, ...invites.value];
    return invite;
  }

  async function deleteInvite(id: string): Promise<void> {
    await api.friendInviteDelete(id);
    invites.value = invites.value.filter((x) => x.id !== id);
  }

  /** Redeem a friend invite token; reloads requests to reflect the new state. */
  async function redeem(token: string): Promise<void> {
    await api.friendRedeem(token);
    requests.value = await api.friendRequests();
  }

  async function accept(id: string): Promise<Friend> {
    const friend = await api.friendRequestAccept(id);
    requests.value = requests.value.filter((x) => x.id !== id);
    upsertFriend(friend);
    return friend;
  }

  async function decline(id: string): Promise<void> {
    await api.friendRequestDecline(id);
    requests.value = requests.value.filter((x) => x.id !== id);
  }

  async function unfriend(userId: string): Promise<void> {
    await api.unfriend(userId);
    friends.value = friends.value.filter((x) => x.userId !== userId);
  }

  function upsertFriend(friend: Friend): void {
    const idx = friends.value.findIndex((x) => x.userId === friend.userId);
    if (idx >= 0) friends.value[idx] = friend;
    else friends.value = [...friends.value, friend];
  }

  function handleFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case 'friend-request': {
        const req = frame.request;
        const idx = requests.value.findIndex((x) => x.id === req.id);
        if (idx >= 0) requests.value[idx] = req;
        else requests.value = [req, ...requests.value];
        break;
      }
      case 'friend-accepted': {
        // An outgoing request was accepted: clear any matching request, add friend.
        const friend = frame.friend;
        requests.value = requests.value.filter((x) => x.userId !== friend.userId);
        upsertFriend(friend);
        break;
      }
      case 'presence': {
        const idx = friends.value.findIndex((x) => x.userId === frame.userId);
        const friend = friends.value[idx];
        if (friend) friends.value[idx] = { ...friend, online: frame.online };
        break;
      }
      default:
        break;
    }
  }

  return {
    friends,
    requests,
    invites,
    load,
    createInvite,
    deleteInvite,
    redeem,
    accept,
    decline,
    unfriend,
    handleFrame,
  };
});
