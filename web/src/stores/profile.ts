import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { ProfileData } from '@notes/shared';
import { settingsGet, settingsSet } from '../lib/native';

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

// My identity as the local core knows it. The handle is the `identity.handle`
// device setting (assigned by the relay at onboarding); the display name is the
// `profile.displayName` setting (chosen at signup). Both live in the encrypted
// vault. E2EE distribution of the display name to friends — and fetching other
// users' profiles — land with the profile cutover; until then `cache` only holds
// what a caller hydrates into it.
export const useProfileStore = defineStore('profile', () => {
  const myData = ref<ProfileData>({});
  const myHandle = ref('');
  const myNameColor = ref<string | null>(null);
  const loaded = ref(false);

  /** My real display name (E2EE), falling back to my public handle. */
  const myDisplayName = computed(() => myData.value.displayName?.trim() || myHandle.value);

  // Profiles of other users, keyed by contact id.
  const cache = ref<Record<string, ProfileEntry>>({});

  /** Load my identity out of the encrypted vault. */
  async function load(): Promise<void> {
    myHandle.value = (await settingsGet('identity.handle')) ?? '';
    const dn = await settingsGet('profile.displayName');
    if (dn) myData.value = { ...myData.value, displayName: dn };
    loaded.value = true;
  }

  /** Save my profile. Replaces the blob wholesale — callers must include every
   *  field they want to keep; prefer `updateProfileData` to avoid dropping one.
   *  Only the display name is persisted today (bio/avatar stay in memory until
   *  the relay-backed profile lands). */
  async function save(data: ProfileData): Promise<void> {
    myData.value = data;
    await settingsSet('profile.displayName', data.displayName?.trim() ?? '');
  }

  /** Merge a partial update into my profile, preserving fields the patch omits —
   *  so editing the avatar/bio can never wipe the display name. */
  async function updateProfileData(patch: Partial<ProfileData>): Promise<void> {
    await save({ ...myData.value, ...patch });
  }

  /** The real display name for a user, if cached. Null otherwise (the caller
   *  falls back to the handle). */
  function displayNameFor(userId: string): string | null {
    return cache.value[userId]?.data?.displayName?.trim() || null;
  }

  /** Avatar for a user — mine from my own profile, others' from cache. */
  function avatarFor(userId: string): string | undefined {
    return cache.value[userId]?.data?.avatar;
  }

  function invalidate(userId: string): void {
    delete cache.value[userId];
  }

  /** Drop everything the vault key decrypted (on lock). */
  function reset(): void {
    myData.value = {};
    myHandle.value = '';
    myNameColor.value = null;
    loaded.value = false;
    cache.value = {};
  }

  return {
    myData,
    myHandle,
    myNameColor,
    myDisplayName,
    loaded,
    cache,
    load,
    save,
    updateProfileData,
    displayNameFor,
    avatarFor,
    invalidate,
    reset,
  };
});
