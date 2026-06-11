// Types shared between server and web client.
// All cryptography happens client-side; the server only ever sees the
// wrapped/encrypted forms defined here.

/** Fixed WebAuthn PRF eval input. PRF output is credential-specific, so this
 * value is not secret; versioned so it can be rotated with a migration. */
export const PRF_EVAL_INPUT = 'notes:mk-wrap:v1';

/** AES-256-GCM ciphertext of a key, plus the HKDF salt used to derive the
 * wrapping key from its source secret (PRF output or recovery code). */
export interface WrappedKey {
  /** base64 HKDF salt */
  salt: string;
  /** base64 12-byte IV */
  iv: string;
  /** base64 ciphertext + GCM tag */
  ct: string;
}

export type Role = 'admin' | 'member';

export interface UserInfo {
  id: string;
  username: string;
  role: Role;
  createdAt: number;
  /** base64 X25519 public key (for future sharing) */
  publicKey: string | null;
}

export interface CredentialInfo {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  hasWrappedMk: boolean;
}

export interface InviteInfo {
  id: string;
  token: string;
  createdAt: number;
  expiresAt: number;
  usedBy: string | null;
}

/** What the client encrypts into a note blob. Never sent in plaintext. */
export interface NotePayload {
  title: string;
  body: string;
  tags: string[];
}

/** A note as stored on the server and in the local IndexedDB cache. */
export interface NoteRecord {
  id: string;
  /** base64 AES-256-GCM ciphertext of JSON NotePayload */
  ciphertext: string;
  /** base64 12-byte IV */
  iv: string;
  /** note key wrapped by the master key */
  wrappedKey: WrappedKey;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
}

/** Keys a user uploads once after signup / recovery re-wrap. */
export interface UserKeys {
  /** base64 X25519 public key */
  publicKey: string;
  /** X25519 private key wrapped by MK */
  wrappedPrivateKey: WrappedKey;
  /** MK wrapped by the recovery-code-derived key */
  recoveryWrappedMk: WrappedKey;
  /** base64 SHA-256 of the recovery auth key (server stores this hash) */
  recoveryAuthHash: string;
}

export interface MetaResponse {
  needsSetup: boolean;
  appName: string;
}

export interface LoginVerifyResponse {
  user: UserInfo;
  credentialId: string;
  /** MK wrapped by this credential's PRF-derived key; null until uploaded */
  wrappedMk: WrappedKey | null;
}

export interface NotesSyncResponse {
  notes: NoteRecord[];
  serverTime: number;
}
