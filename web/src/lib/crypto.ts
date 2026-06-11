import { x25519 } from '@noble/curves/ed25519';
import type { NotePayload, NoteRecord, SealedKey, SharedNoteRecord, WrappedKey } from '@notes/shared';
import { b64, ub64 } from './b64';

const te = new TextEncoder();
const td = new TextDecoder();

export const INFO_MK_WRAP = 'notes:wrap:mk:v1';
export const INFO_NOTE_KEY = 'notes:wrap:note-key:v1';
export const INFO_PRIVATE_KEY = 'notes:wrap:x25519:v1';
export const INFO_RECOVERY_WRAP = 'notes:wrap:recovery:v1';
export const INFO_SEAL = 'notes:seal:x25519:v1';

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export function generateMasterKey(): Uint8Array {
  return randomBytes(32);
}

async function deriveAesKey(secret: Uint8Array, salt: Uint8Array, info: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', secret as BufferSource, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: te.encode(info) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function hkdfBits(secret: Uint8Array, salt: Uint8Array, info: string, bytes = 32): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey('raw', secret as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: te.encode(info) },
    material,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

/** Encrypt `raw` with an AES-256-GCM key derived from `secret` via HKDF. */
export async function wrapKey(secret: Uint8Array, raw: Uint8Array, info: string): Promise<WrappedKey> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveAesKey(secret, salt, info);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, raw as BufferSource);
  return { salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

export async function unwrapKey(secret: Uint8Array, wrapped: WrappedKey, info: string): Promise<Uint8Array> {
  const key = await deriveAesKey(secret, ub64(wrapped.salt), info);
  const raw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ub64(wrapped.iv) as BufferSource },
    key,
    ub64(wrapped.ct) as BufferSource,
  );
  return new Uint8Array(raw);
}

export interface EncryptedNoteData {
  ciphertext: string;
  iv: string;
  wrappedKey: WrappedKey;
}

export async function encryptNotePayload(
  mk: Uint8Array,
  payload: NotePayload,
  existingWrappedKey?: WrappedKey,
): Promise<EncryptedNoteData> {
  let noteKeyRaw: Uint8Array;
  let wrappedKey: WrappedKey;
  if (existingWrappedKey) {
    noteKeyRaw = await unwrapKey(mk, existingWrappedKey, INFO_NOTE_KEY);
    wrappedKey = existingWrappedKey;
  } else {
    noteKeyRaw = randomBytes(32);
    wrappedKey = await wrapKey(mk, noteKeyRaw, INFO_NOTE_KEY);
  }
  const key = await crypto.subtle.importKey('raw', noteKeyRaw as BufferSource, 'AES-GCM', false, ['encrypt']);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    te.encode(JSON.stringify(payload)),
  );
  return { ciphertext: b64(new Uint8Array(ct)), iv: b64(iv), wrappedKey };
}

export async function decryptNotePayload(mk: Uint8Array, record: NoteRecord): Promise<NotePayload> {
  const noteKeyRaw = await unwrapKey(mk, record.wrappedKey, INFO_NOTE_KEY);
  const key = await crypto.subtle.importKey('raw', noteKeyRaw as BufferSource, 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ub64(record.iv) as BufferSource },
    key,
    ub64(record.ciphertext) as BufferSource,
  );
  return JSON.parse(td.decode(pt)) as NotePayload;
}

/** X25519 keypair for future note sharing. noble is used for portability;
 * WebCrypto X25519 is still missing in some browsers. */
export function generateKeyPair(): { publicKey: Uint8Array; privateKey: Uint8Array } {
  const privateKey = x25519.utils.randomPrivateKey();
  return { publicKey: x25519.getPublicKey(privateKey), privateKey };
}

/** Seal a raw key to a recipient's X25519 public key: ephemeral keypair +
 * ECDH + HKDF + AES-256-GCM ("sealed box" style). */
export async function sealKey(recipientPublicKey: Uint8Array, raw: Uint8Array): Promise<SealedKey> {
  const eph = generateKeyPair();
  const shared = x25519.getSharedSecret(eph.privateKey, recipientPublicKey);
  const salt = concat(eph.publicKey, recipientPublicKey);
  const key = await deriveAesKey(shared, salt, INFO_SEAL);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, raw as BufferSource);
  return { epk: b64(eph.publicKey), iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

export async function unsealKey(myPrivateKey: Uint8Array, myPublicKey: Uint8Array, sealed: SealedKey): Promise<Uint8Array> {
  const epk = ub64(sealed.epk);
  const shared = x25519.getSharedSecret(myPrivateKey, epk);
  const key = await deriveAesKey(shared, concat(epk, myPublicKey), INFO_SEAL);
  const raw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ub64(sealed.iv) as BufferSource },
    key,
    ub64(sealed.ct) as BufferSource,
  );
  return new Uint8Array(raw);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Decrypt a shared note: unseal its note key, then decrypt the payload. */
export async function decryptSharedNotePayload(
  myPrivateKey: Uint8Array,
  myPublicKey: Uint8Array,
  record: SharedNoteRecord,
): Promise<{ payload: NotePayload; noteKeyRaw: Uint8Array }> {
  const noteKeyRaw = await unsealKey(myPrivateKey, myPublicKey, record.sealedKey);
  const key = await crypto.subtle.importKey('raw', noteKeyRaw as BufferSource, 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ub64(record.iv) as BufferSource },
    key,
    ub64(record.ciphertext) as BufferSource,
  );
  return { payload: JSON.parse(td.decode(pt)) as NotePayload, noteKeyRaw };
}

/** Encrypt a payload with an already-known raw note key (shared-note editing). */
export async function encryptWithNoteKey(noteKeyRaw: Uint8Array, payload: NotePayload): Promise<{ ciphertext: string; iv: string }> {
  const key = await crypto.subtle.importKey('raw', noteKeyRaw as BufferSource, 'AES-GCM', false, ['encrypt']);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, te.encode(JSON.stringify(payload)));
  return { ciphertext: b64(new Uint8Array(ct)), iv: b64(iv) };
}

/** Unwrap a note key with the master key (owner side, for sharing). */
export async function unwrapNoteKey(mk: Uint8Array, wrappedKey: WrappedKey): Promise<Uint8Array> {
  return unwrapKey(mk, wrappedKey, INFO_NOTE_KEY);
}

// ---- Encrypted attachments ----

export async function encryptBlob(data: Uint8Array): Promise<{ ciphertext: Uint8Array; key: string; iv: string }> {
  const keyRaw = randomBytes(32);
  const iv = randomBytes(12);
  const key = await crypto.subtle.importKey('raw', keyRaw as BufferSource, 'AES-GCM', false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, data as BufferSource);
  return { ciphertext: new Uint8Array(ct), key: b64(keyRaw), iv: b64(iv) };
}

export async function decryptBlob(ciphertext: Uint8Array, keyB64: string, ivB64: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ub64(keyB64) as BufferSource, 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ub64(ivB64) as BufferSource },
    key,
    ciphertext as BufferSource,
  );
  return new Uint8Array(pt);
}

export async function sha256b64(data: Uint8Array): Promise<string> {
  return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource)));
}
