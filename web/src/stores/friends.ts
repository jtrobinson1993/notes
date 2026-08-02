import { defineStore } from 'pinia';
import { ref } from 'vue';
import { friendsList, friendRemove } from '../lib/native';
import { createInvite as nativeCreateInvite, redeemInvite as nativeRedeemInvite } from '../lib/nativeFriends';

/** A friend as the local core knows them (D4b). `userId` is their contact id —
 *  their per-relay identity key — and `displayName` is the decrypted real name
 *  when we have one, else their public handle. */
export interface FriendEntry {
  userId: string;
  handle: string;
  displayName: string;
  /** True only when the relay's key-transparency log has *proved* this contact's
   *  key belongs to their handle. Anything else — relay unreachable when they
   *  were added, handle absent from the log, an interim-KT relay — is false, and
   *  must never be rendered as verified. */
  ktVerified: boolean;
}

/** A friend invite I minted. The self-describing `token` string IS the shareable
 *  code (it embeds the relay + my pinned keys + a one-time token); nothing about
 *  it is stored server-side, so this list is in-memory for the session only. */
export interface FriendInviteEntry {
  id: string;
  token: string;
  createdAt: number;
  expiresAt: number;
}

// v8 D4b: friends live in the local store, recorded by the mailbox drain when
// the friend-accept/confirm handshake completes. There are no server-held
// friend requests and no presence — the handshake auto-friends, so a redeemed
// invite becomes a friend as soon as the inviter's confirm drains.
export const useFriendsStore = defineStore('friends', () => {
  const friends = ref<FriendEntry[]>([]);
  const invites = ref<FriendInviteEntry[]>([]);

  async function load(): Promise<void> {
    friends.value = (await friendsList()).map((s) => ({
      userId: s.contact_id,
      handle: s.handle,
      displayName: s.display_name?.trim() || s.handle,
      // A missing/absent epoch is "never proven", not "fine" — default false.
      ktVerified: typeof s.kt_verified_epoch === 'number',
    }));
  }

  async function createInvite(): Promise<FriendInviteEntry> {
    const { invite, expiresAt } = await nativeCreateInvite();
    const entry: FriendInviteEntry = {
      id: crypto.randomUUID(),
      token: invite,
      createdAt: Date.now(),
      expiresAt,
    };
    invites.value = [entry, ...invites.value];
    return entry;
  }

  /** Nothing server-side to revoke beyond the one-time token (it expires); just
   *  drop it from the local list. */
  function deleteInvite(id: string): void {
    invites.value = invites.value.filter((x) => x.id !== id);
  }

  /** Redeem a pasted invite string: sealing a friend-accept kicks off the D4b
   *  handshake, and the friendship lands once the inviter's confirm drains. */
  async function redeem(token: string): Promise<void> {
    await nativeRedeemInvite(token);
    await load();
  }

  async function unfriend(userId: string): Promise<void> {
    await friendRemove(userId); // drops the friend flag + addressing locally
    friends.value = friends.value.filter((x) => x.userId !== userId);
  }

  /** Drop the decrypted friend list + any minted invites (on lock). */
  function reset(): void {
    friends.value = [];
    invites.value = [];
  }

  return { friends, invites, load, createInvite, deleteInvite, redeem, unfriend, reset };
});
