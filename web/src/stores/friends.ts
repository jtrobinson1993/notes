import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Friend, FriendInvite, FriendRequest, ServerFrame } from '@notes/shared';
import { api } from '../lib/api';
import { isNative, friendsList, friendRemove } from '../lib/native';
import { createInvite as nativeCreateInvite, redeemInvite as nativeRedeemInvite } from '../lib/nativeFriends';
import { useProfileStore } from './profile';

export const useFriendsStore = defineStore('friends', () => {
  const friends = ref<Friend[]>([]);
  const requests = ref<FriendRequest[]>([]);
  const invites = ref<FriendInvite[]>([]);

  async function load(): Promise<void> {
    if (isNative) {
      // v8 D4b: friends live in the local store (recorded by the drain when the
      // friend-accept/confirm handshake completes). There are no server-held
      // requests or a persisted invite list — the handshake auto-friends, and an
      // invite is a self-describing string you generate + share.
      friends.value = (await friendsList()).map((s) => ({
        userId: s.contact_id,
        displayName: s.display_name?.trim() || s.handle,
        handle: s.handle,
        publicKey: null,
        online: false,
      }));
      requests.value = [];
      return;
    }
    const [f, r, i] = await Promise.all([api.friends(), api.friendRequests(), api.friendInvites()]);
    friends.value = f;
    requests.value = r;
    invites.value = i;
    void hydrateNames();
  }

  /** Overlay friends' decrypted real display names (the server only sends the
   *  public handle). Pending requests stay as handles — you can't decrypt a
   *  non-contact's profile. */
  async function hydrateNames(): Promise<void> {
    const profile = useProfileStore();
    await profile.hydrate(friends.value.map((f) => f.userId));
    for (const f of friends.value) {
      const real = profile.displayNameFor(f.userId);
      if (real && f.displayName !== real) f.displayName = real;
    }
  }

  async function createInvite(): Promise<FriendInvite> {
    if (isNative) {
      // Same D4b orchestration the DM panel uses (nativeFriends). The
      // self-describing invite string IS the shareable code (embeds relay + my
      // pinned keys + the one-time token); it isn't persisted server-side.
      const { invite, expiresAt } = await nativeCreateInvite();
      const fi: FriendInvite = { id: crypto.randomUUID(), token: invite, createdAt: Date.now(), expiresAt };
      invites.value = [fi, ...invites.value];
      return fi;
    }
    const invite = await api.friendInviteCreate();
    invites.value = [invite, ...invites.value];
    return invite;
  }

  async function deleteInvite(id: string): Promise<void> {
    if (isNative) {
      // Nothing server-side to revoke beyond the one-time token (it expires); just
      // drop it from the local list.
      invites.value = invites.value.filter((x) => x.id !== id);
      return;
    }
    await api.friendInviteDelete(id);
    invites.value = invites.value.filter((x) => x.id !== id);
  }

  /** Redeem a friend invite. Native: the "token" is the pasted self-describing
   *  invite string; sealing a friend-accept kicks off the D4b handshake, and the
   *  friendship lands once the inviter's confirm drains (so we reload). */
  async function redeem(token: string): Promise<void> {
    if (isNative) {
      await nativeRedeemInvite(token); // token = the pasted self-describing invite
      await load();
      return;
    }
    await api.friendRedeem(token);
    requests.value = await api.friendRequests();
  }

  async function accept(id: string): Promise<Friend> {
    const friend = await api.friendRequestAccept(id);
    requests.value = requests.value.filter((x) => x.id !== id);
    upsertFriend(friend);
    // Share my profile with the new friend (the other side does the same on its
    // 'friend-accepted' frame).
    void useProfileStore().distributeTo(friend);
    return friend;
  }

  async function decline(id: string): Promise<void> {
    await api.friendRequestDecline(id);
    requests.value = requests.value.filter((x) => x.id !== id);
  }

  async function unfriend(userId: string): Promise<void> {
    if (isNative) {
      await friendRemove(userId); // native store drops the friend flag + addressing
      friends.value = friends.value.filter((x) => x.userId !== userId);
      return;
    }
    await api.unfriend(userId);
    friends.value = friends.value.filter((x) => x.userId !== userId);
    // Rotate my profile key so the removed friend can't read future updates.
    void useProfileStore().rotate();
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
    hydrateNames,
    createInvite,
    deleteInvite,
    redeem,
    accept,
    decline,
    unfriend,
    handleFrame,
  };
});
