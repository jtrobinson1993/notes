import type { MessagePayload, ReactionPayload, SealedEpochKey, SealedKey, SealedMemberKey } from '@notes/shared';
import { b64, ub64 } from './b64';
import { randomBytes, sealKey, unsealKey } from './crypto';

const te = new TextEncoder();
const td = new TextDecoder();

/** Encrypt an arbitrary string with the conversation key (e.g. a group icon
 *  data URL). AES-256-GCM, random IV — same primitive as messages. */
export async function encryptText(convKey: Uint8Array, text: string): Promise<{ ciphertext: string; iv: string }> {
  const key = await crypto.subtle.importKey('raw', convKey as BufferSource, 'AES-GCM', false, ['encrypt']);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, te.encode(text));
  return { ciphertext: b64(new Uint8Array(ct)), iv: b64(iv) };
}

/** Decrypt a string encrypted with `encryptText`. */
export async function decryptText(convKey: Uint8Array, ciphertext: string, iv: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', convKey as BufferSource, 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(iv) as BufferSource }, key, ub64(ciphertext) as BufferSource);
  return td.decode(pt);
}

/** Fresh 32-byte AES-256-GCM conversation key. */
export function generateConversationKey(): Uint8Array {
  return randomBytes(32);
}

/** Seal a conversation key to a member's X25519 public key (base64). */
export function sealConversationKey(memberPublicKeyB64: string, convKey: Uint8Array): Promise<SealedKey> {
  return sealKey(ub64(memberPublicKeyB64), convKey);
}

/** Seal one conversation key to many members (a re-key). Returns a
 *  `SealedMemberKey` per recipient, ready to POST. Members without a public key
 *  are skipped by the caller before this point. */
export async function sealConversationKeyToMembers(
  members: { userId: string; publicKey: string }[],
  convKey: Uint8Array,
): Promise<SealedMemberKey[]> {
  return Promise.all(
    members.map(async (m) => ({ userId: m.userId, sealedKey: await sealConversationKey(m.publicKey, convKey) })),
  );
}

/** Seal a set of (epoch, key) pairs to one recipient — used to hand a new joiner
 *  every prior epoch key when the inviter chose to share history. */
export async function sealEpochKeysTo(
  recipientPublicKeyB64: string,
  epochKeys: { epoch: number; key: Uint8Array }[],
): Promise<SealedEpochKey[]> {
  return Promise.all(
    epochKeys.map(async (e) => ({ epoch: e.epoch, sealedKey: await sealConversationKey(recipientPublicKeyB64, e.key) })),
  );
}

/** Unseal a conversation key sealed to me. Pure: caller passes the keypair
 * from session.getKeyPair(). */
export function unsealConversationKey(
  sealed: SealedKey,
  privateKey: Uint8Array,
  publicKey: Uint8Array,
): Promise<Uint8Array> {
  return unsealKey(privateKey, publicKey, sealed);
}

/** Encrypt a message payload with the conversation key (AES-256-GCM, random IV). */
export async function encryptMessage(
  convKey: Uint8Array,
  payload: MessagePayload,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await crypto.subtle.importKey('raw', convKey as BufferSource, 'AES-GCM', false, ['encrypt']);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    te.encode(JSON.stringify(payload)),
  );
  return { ciphertext: b64(new Uint8Array(ct)), iv: b64(iv) };
}

/** Decrypt a message blob with the conversation key. */
export async function decryptMessage(
  convKey: Uint8Array,
  ciphertext: string,
  iv: string,
): Promise<MessagePayload> {
  const key = await crypto.subtle.importKey('raw', convKey as BufferSource, 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ub64(iv) as BufferSource },
    key,
    ub64(ciphertext) as BufferSource,
  );
  return JSON.parse(td.decode(pt)) as MessagePayload;
}

/** Encrypt a reaction emoji with the conversation key. */
export async function encryptReaction(
  convKey: Uint8Array,
  emoji: string,
): Promise<{ ciphertext: string; iv: string }> {
  return encryptMessage(convKey, { emoji } as unknown as MessagePayload);
}

/** Decrypt a reaction blob to its emoji string. */
export async function decryptReaction(convKey: Uint8Array, ciphertext: string, iv: string): Promise<string> {
  const payload = (await decryptMessage(convKey, ciphertext, iv)) as unknown as ReactionPayload;
  return payload.emoji;
}
