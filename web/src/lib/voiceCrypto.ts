import type { SealedKey } from '@notes/shared';
import { generateConversationKey, sealConversationKey, unsealConversationKey } from './chatCrypto';

// End-to-end frame encryption for voice (WebRTC Encoded Transform / insertable
// streams). Each encoded Opus frame is sealed with AES-256-GCM under the call's
// per-epoch **media key**, which the SFU never has — so it forwards opaque
// frames. The media key is distributed/rotated using the same X25519 sealing
// primitive as chat conversation keys (see chatCrypto). The wire format of an
// encrypted frame payload is:
//
//   [ epoch: 4 bytes big-endian ][ iv: 12 bytes ][ AES-GCM ciphertext+tag ]
//
// The epoch prefix lets a receiver pick the right key across a rekey, and is
// safe to prepend because the SFU treats the audio payload as opaque.

/** Generate a fresh 32-byte media key (same primitive as a conversation key). */
export function generateMediaKey(): Uint8Array {
  return generateConversationKey();
}

/** Seal the media key to a member's X25519 public key (base64). */
export function sealMediaKey(memberPublicKeyB64: string, mediaKey: Uint8Array): Promise<SealedKey> {
  return sealConversationKey(memberPublicKeyB64, mediaKey);
}

/** Unseal a media key sealed to me. */
export function unsealMediaKey(sealed: SealedKey, myPrivateKey: Uint8Array, myPublicKey: Uint8Array): Promise<Uint8Array> {
  return unsealConversationKey(sealed, myPrivateKey, myPublicKey);
}

/** Import a raw media key as a non-extractable AES-GCM CryptoKey. */
export function importFrameKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

const EPOCH_BYTES = 4;
const IV_BYTES = 12;
const HEADER = EPOCH_BYTES + IV_BYTES;

function writeEpoch(view: Uint8Array, epoch: number): void {
  view[0] = (epoch >>> 24) & 0xff;
  view[1] = (epoch >>> 16) & 0xff;
  view[2] = (epoch >>> 8) & 0xff;
  view[3] = epoch & 0xff;
}
function readEpoch(view: Uint8Array): number {
  return (((view[0] ?? 0) << 24) | ((view[1] ?? 0) << 16) | ((view[2] ?? 0) << 8) | (view[3] ?? 0)) >>> 0;
}

/** Encrypt an encoded-frame payload, prefixing epoch + IV. */
export async function encryptFrame(epoch: number, key: CryptoKey, payload: ArrayBuffer): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload));
  const out = new Uint8Array(HEADER + ct.length);
  writeEpoch(out, epoch);
  out.set(iv, EPOCH_BYTES);
  out.set(ct, HEADER);
  return out.buffer;
}

/** Decrypt an encrypted frame. Resolves the key by epoch via `keyForEpoch`;
 *  returns null on unknown epoch, malformed input, or auth-tag failure (so the
 *  caller can drop the frame rather than play noise). */
export async function decryptFrame(
  keyForEpoch: (epoch: number) => CryptoKey | undefined,
  data: ArrayBuffer,
): Promise<ArrayBuffer | null> {
  const buf = new Uint8Array(data);
  if (buf.length <= HEADER) return null;
  const key = keyForEpoch(readEpoch(buf));
  if (!key) return null;
  const iv = buf.subarray(EPOCH_BYTES, HEADER);
  const ct = buf.subarray(HEADER);
  try {
    return await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  } catch {
    return null;
  }
}
