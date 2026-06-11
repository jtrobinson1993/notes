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

/** Note key sealed to a recipient's X25519 public key (ephemeral-static DH). */
export interface SealedKey {
  /** base64 ephemeral X25519 public key */
  epk: string;
  /** base64 12-byte IV */
  iv: string;
  /** base64 ciphertext + GCM tag */
  ct: string;
}

export type ShareAccess = 'read' | 'write';

export interface MemberInfo {
  id: string;
  username: string;
  publicKey: string | null;
}

export interface ShareInfo {
  noteId: string;
  recipientId: string;
  recipientUsername: string;
  access: ShareAccess;
  createdAt: number;
}

/** A reference to an encrypted attachment. Lives *inside* the encrypted note
 * payload, so the per-attachment key is never visible to the server and
 * sharing the note automatically shares its attachments. */
export interface AttachmentRef {
  id: string;
  name: string;
  type: string;
  size: number;
  /** base64 raw 32-byte AES-256-GCM key */
  key: string;
  /** base64 12-byte IV used for the blob */
  iv: string;
}

/** What the client encrypts into a note blob. Never sent in plaintext. */
export interface NotePayload {
  title: string;
  body: string;
  tags: string[];
  attachments?: AttachmentRef[];
}

export interface NoteVersionInfo {
  id: number;
  createdAt: number;
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

/** A note shared *with* the current user. */
export interface SharedNoteRecord {
  id: string;
  ciphertext: string;
  iv: string;
  /** note key sealed to my X25519 public key */
  sealedKey: SealedKey;
  ownerUsername: string;
  access: ShareAccess;
  createdAt: number;
  updatedAt: number;
}
