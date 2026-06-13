import type { MessagePayload, SealedKey } from '@notes/shared';
import { b64, ub64 } from './b64';
import { randomBytes, sealKey, unsealKey } from './crypto';

const te = new TextEncoder();
const td = new TextDecoder();

/** Fresh 32-byte AES-256-GCM conversation key. */
export function generateConversationKey(): Uint8Array {
  return randomBytes(32);
}

/** Seal a conversation key to a member's X25519 public key (base64). */
export function sealConversationKey(memberPublicKeyB64: string, convKey: Uint8Array): Promise<SealedKey> {
  return sealKey(ub64(memberPublicKeyB64), convKey);
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
