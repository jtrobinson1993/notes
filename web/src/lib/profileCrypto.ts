import type { ProfileData, SealedKey, WrappedKey } from '@notes/shared';
import { b64, ub64 } from './b64';
import { randomBytes, sealKey, unsealKey, unwrapKey, wrapKey } from './crypto';

// A user's profile (bio + avatar) is encrypted under a per-user **profile key**:
// a random 32-byte AES-256-GCM key. The profile key is (a) wrapped under the
// owner's master key so the owner can recover it on any device, and (b) sealed
// to each contact who may render the profile. Rotating the key (new key +
// re-encrypt + re-seal to the remaining contacts) revokes a contact's access to
// future updates. This mirrors the chat conversation-key machinery.

const te = new TextEncoder();
const td = new TextDecoder();

/** HKDF info for wrapping the profile key under the master key. */
export const INFO_PROFILE_KEY = 'notes:wrap:profile-key:v1';

export function generateProfileKey(): Uint8Array {
  return randomBytes(32);
}

/** Encrypt the profile contents under the profile key (AES-256-GCM). */
export async function encryptProfile(
  profileKey: Uint8Array,
  data: ProfileData,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await crypto.subtle.importKey('raw', profileKey as BufferSource, 'AES-GCM', false, ['encrypt']);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    te.encode(JSON.stringify(data)),
  );
  return { ciphertext: b64(new Uint8Array(ct)), iv: b64(iv) };
}

export async function decryptProfile(
  profileKey: Uint8Array,
  ciphertext: string,
  iv: string,
): Promise<ProfileData> {
  const key = await crypto.subtle.importKey('raw', profileKey as BufferSource, 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ub64(iv) as BufferSource },
    key,
    ub64(ciphertext) as BufferSource,
  );
  return JSON.parse(td.decode(pt)) as ProfileData;
}

/** Wrap the profile key under the owner's master key (for cross-device recovery). */
export function wrapProfileKey(mk: Uint8Array, profileKey: Uint8Array): Promise<WrappedKey> {
  return wrapKey(mk, profileKey, INFO_PROFILE_KEY);
}

export function unwrapProfileKey(mk: Uint8Array, wrapped: WrappedKey): Promise<Uint8Array> {
  return unwrapKey(mk, wrapped, INFO_PROFILE_KEY);
}

/** Seal the profile key to a contact's X25519 public key. */
export function sealProfileKey(recipientPublicKey: Uint8Array, profileKey: Uint8Array): Promise<SealedKey> {
  return sealKey(recipientPublicKey, profileKey);
}

export function unsealProfileKey(
  myPrivateKey: Uint8Array,
  myPublicKey: Uint8Array,
  sealed: SealedKey,
): Promise<Uint8Array> {
  return unsealKey(myPrivateKey, myPublicKey, sealed);
}
