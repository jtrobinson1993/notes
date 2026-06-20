import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { ProfileData, SealedProfileKey } from '@notes/shared';
import { api } from '../lib/api';
import { ub64 } from '../lib/b64';
import {
  decryptProfile,
  encryptProfile,
  generateProfileKey,
  sealProfileKey,
  unsealProfileKey,
  unwrapProfileKey,
  wrapProfileKey,
} from '../lib/profileCrypto';
import { useChatStore } from './chat';
import { useFriendsStore } from './friends';
import { useSessionStore } from './session';

/** A contact's profile as the viewer sees it. `displayName` is the decrypted
 *  real name when the viewer is a contact, otherwise the public handle. `handle`
 *  is always the public "Word#1234". `data` holds the decrypted bio/avatar (and
 *  real name) when the viewer has access, else null. */
export interface ProfileEntry {
  displayName: string;
  handle: string;
  nameColor: string | null;
  data: ProfileData | null;
}

export const useProfileStore = defineStore('profile', () => {
  const session = useSessionStore();

  // My own profile key (in-memory only, like conversation keys), contents,
  // visibility, and rotation epoch.
  let profileKey: Uint8Array | null = null;
  const myData = ref<ProfileData>({});
  const myHandle = ref('');
  const friendsOnly = ref(true);
  const linkPreviews = ref(false);
  const epoch = ref(0);
  const loaded = ref(false);

  /** My real display name (E2EE), falling back to my public handle. */
  const myDisplayName = computed(() => myData.value.displayName?.trim() || myHandle.value);

  // Decrypted profiles of other users, keyed by userId.
  const cache = ref<Record<string, ProfileEntry>>({});

  /** Load my profile info + (if set) decrypt my own blob via the MK-wrapped key. */
  async function load(): Promise<void> {
    const info = await api.profileGet();
    myHandle.value = info.handle;
    friendsOnly.value = info.friendsOnly;
    linkPreviews.value = info.linkPreviews;
    const { profile } = await api.profileDataGet();
    if (profile && session.mk) {
      profileKey = await unwrapProfileKey(session.mk, profile.ownerWrappedKey);
      myData.value = await decryptProfile(profileKey, profile.ciphertext, profile.iv);
      epoch.value = profile.epoch;
    }
    loaded.value = true;
    // One-time migration: an account from before display names were encrypted
    // still has a legacy plaintext name on the server. Move it into the encrypted
    // profile, then clear the plaintext so the server can no longer read it.
    const legacy = info.displayName;
    if (session.mk && !myData.value.displayName && legacy && legacy !== info.handle && !legacy.startsWith('User-')) {
      try {
        await save({ ...myData.value, displayName: legacy });
        await api.profileSet({ displayName: null });
      } catch {
        /* best-effort; a later save retries the encryption */
      }
    }
  }

  /** Who may currently receive my profile: friends, plus group co-members when
   *  visibility isn't friends-only. */
  function recipients(): { userId: string; publicKey: string | null }[] {
    const map = new Map<string, string | null>();
    for (const f of useFriendsStore().friends) map.set(f.userId, f.publicKey);
    if (!friendsOnly.value) {
      const meId = session.user?.id;
      for (const c of useChatStore().conversations) {
        for (const m of c.members) if (m.userId !== meId) map.set(m.userId, m.publicKey);
      }
    }
    return [...map].map(([userId, publicKey]) => ({ userId, publicKey }));
  }

  async function sealToRecipients(key: Uint8Array): Promise<SealedProfileKey[]> {
    const out: SealedProfileKey[] = [];
    for (const r of recipients()) {
      if (!r.publicKey) continue;
      out.push({ recipientId: r.userId, sealedKey: await sealProfileKey(ub64(r.publicKey), key) });
    }
    return out;
  }

  async function persist(newEpoch: number): Promise<void> {
    if (!session.mk || !profileKey) throw new Error('locked');
    const { ciphertext, iv } = await encryptProfile(profileKey, myData.value);
    const ownerWrappedKey = await wrapProfileKey(session.mk, profileKey);
    const keys = await sealToRecipients(profileKey);
    const res = await api.profileDataSet({ ciphertext, iv, epoch: newEpoch, ownerWrappedKey, keys });
    epoch.value = res.epoch;
  }

  /** Save my profile (bio/avatar). Generates the profile key on first use. */
  async function save(data: ProfileData): Promise<void> {
    myData.value = data;
    if (!profileKey) profileKey = generateProfileKey();
    await persist(epoch.value);
  }

  async function setVisibility(v: boolean): Promise<void> {
    const info = await api.profileVisibilitySet(v);
    friendsOnly.value = info.friendsOnly;
    // Widening (off) redistributes to co-members; tightening was revoked server-side.
    if (!v && profileKey) await persist(epoch.value);
  }

  async function setLinkPreviews(v: boolean): Promise<void> {
    const info = await api.linkPreviewsSet(v);
    linkPreviews.value = info.linkPreviews;
  }

  /** Rotate after a contact loses access: new key, bumped epoch, re-sealed to the
   *  remaining recipients — so the lost contact can't read future updates. */
  async function rotate(): Promise<void> {
    if (!profileKey) return; // nothing published yet
    profileKey = generateProfileKey();
    await persist(epoch.value + 1);
  }

  /** Distribute the current profile key to a newly accepted friend (no rotation). */
  async function distributeTo(friend: { userId: string; publicKey: string | null }): Promise<void> {
    if (!profileKey || !friend.publicKey) return;
    const sealed = await sealProfileKey(ub64(friend.publicKey), profileKey);
    try {
      await api.profileKeysAdd(epoch.value, [{ recipientId: friend.userId, sealedKey: sealed }]);
    } catch {
      // No profile set, or an epoch race — safe to ignore; the next save re-seals.
    }
  }

  /** Fetch + decrypt another user's profile (cached). */
  async function fetch(userId: string): Promise<ProfileEntry> {
    const cached = cache.value[userId];
    if (cached) return cached;
    const view = await api.userProfileGet(userId);
    let data: ProfileData | null = null;
    if (view.encrypted) {
      try {
        const { privateKey, publicKey } = await session.getKeyPair();
        const key = await unsealProfileKey(privateKey, publicKey, view.encrypted.sealedKey);
        data = await decryptProfile(key, view.encrypted.ciphertext, view.encrypted.iv);
      } catch {
        data = null;
      }
    }
    const entry: ProfileEntry = {
      // view.displayName is the public handle; prefer the decrypted real name.
      displayName: data?.displayName?.trim() || view.displayName,
      handle: view.handle,
      nameColor: view.nameColor,
      data,
    };
    cache.value[userId] = entry;
    return entry;
  }

  /** The decrypted real display name for a user, if I'm a contact and it's
   *  cached. Null otherwise (caller falls back to the handle). */
  function displayNameFor(userId: string): string | null {
    return cache.value[userId]?.data?.displayName?.trim() || null;
  }

  /** Pre-fetch + cache profiles for these users so `displayNameFor` resolves. */
  async function hydrate(userIds: string[]): Promise<void> {
    await Promise.all(userIds.map((id) => fetch(id).catch(() => {})));
  }

  function invalidate(userId: string): void {
    delete cache.value[userId];
  }

  function reset(): void {
    profileKey = null;
    myData.value = {};
    myHandle.value = '';
    friendsOnly.value = true;
    linkPreviews.value = false;
    epoch.value = 0;
    loaded.value = false;
    cache.value = {};
  }

  return {
    myData,
    myHandle,
    myDisplayName,
    friendsOnly,
    linkPreviews,
    epoch,
    loaded,
    cache,
    load,
    save,
    setVisibility,
    setLinkPreviews,
    rotate,
    distributeTo,
    fetch,
    displayNameFor,
    hydrate,
    invalidate,
    reset,
  };
});
