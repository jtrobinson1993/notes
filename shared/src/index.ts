// Types shared between server and web client.
// All cryptography happens client-side; the server only ever sees the
// wrapped/encrypted forms defined here.

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
  role: Role;
  createdAt: number;
  /** public "Word#1234" handle (the name shown to non-contacts) */
  handle: string;
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
  /** Intrinsic pixel dimensions, when known (currently videos, for a correctly
   *  sized poster before the clip is loaded). */
  width?: number;
  height?: number;
  /** For videos: a small, separately-encrypted poster image (a captured frame)
   *  shown before the full clip is decrypted. Same key model as any attachment —
   *  the key/iv live inside the (encrypted) message payload. */
  poster?: { id: string; key: string; iv: string; type: string };
}

/** What the client encrypts into a note blob. Never sent in plaintext. */
export interface NotePayload {
  title: string;
  body: string;
  tags: string[];
  attachments?: AttachmentRef[];
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

/** A note shared *with* the current user. */
export interface SharedNoteRecord {
  id: string;
  ciphertext: string;
  iv: string;
  /** note key sealed to my X25519 public key */
  sealedKey: SealedKey;
  ownerDisplayName: string;
  access: ShareAccess;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// E2EE chat payload pieces. These live *inside* the client-encrypted message
// blob, so the relay never sees any of them; they are shared only so the native
// client and the relay's content proxies agree on the shapes.
// ---------------------------------------------------------------------------

/** An inline, non-chat event (e.g. someone joined). Carried inside the encrypted
 *  message payload — so the server never sees it — and rendered as a centered
 *  system notice instead of a normal bubble. */
export interface SystemEvent {
  kind: 'member-joined';
  /** the user the event is about */
  userId: string;
  /** index into the client's join-phrase list (keeps a message's funny line
   *  stable for everyone, while the display name resolves live) */
  phrase: number;
}

/** Open Graph metadata for a link, fetched via the server-side `/api/og` proxy
 *  and embedded in the (encrypted) message payload. The `image` is a remote URL
 *  rendered with click-to-load, like any other remote image. */
export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

/** A snapshot of the message being replied to, embedded in the reply's payload. */
export interface ReplyRef {
  /** parent message's per-conversation sequence number */
  seq: number;
  /** parent sender's user id (rendered via the member list's display name) */
  senderId: string;
  /** short plaintext preview of the parent (already decrypted by the sender) */
  preview: string;
}

/** One normalized GIF search hit returned by the server-side KLIPY proxy. */
export interface GifSearchResult {
  id: string;
  title: string;
  url: string;
  previewUrl: string;
  width: number;
  height: number;
}

/** Server-side KLIPY proxy response. `next` is an opaque pagination cursor
 *  (page number as a string) or null when there are no more results. */
export interface GifSearchResponse {
  results: GifSearchResult[];
  next: string | null;
}

/** One 7TV emote returned by the relay's emote-search proxy. `url` is a
 *  relay-relative capability path (`/api/relay/emote/<sig>/<id>.webp`) that an
 *  `<img>` can load directly — the relay fetches and caches the image so the
 *  client's IP never reaches 7TV. */
export interface EmoteSearchResult {
  id: string;
  name: string;
  url: string;
  width: number;
  height: number;
  animated: boolean;
}

/** Relay emote-search response. `next` is the next page number as a string, or
 *  null when the page came back short. */
export interface EmoteSearchResponse {
  results: EmoteSearchResult[];
  next: string | null;
}

/** The owner-set, E2E-encrypted profile contents. Encrypted under a per-user
 *  **profile key** and embedded whole (avatar is a small optimized data URL),
 *  so the server never sees any of it. */
export interface ProfileData {
  /** the real display name, shown only to contacts (the server never sees it) */
  displayName?: string;
  bio?: string;
  /** small optimized avatar as a `data:image/webp` URL */
  avatar?: string;
}

// ---- Web Push (background notifications) ----

/** The content-free payload the server pushes; the client opens and decrypts.
 *  A `call` ping notifies a callee whose devices have no live socket.
 *
 *  A `message` ping carries only routing metadata (no plaintext): which
 *  conversation/channel and the new message's `seq`, so the client can open the
 *  exact channel and scroll to the message. For a reply-thread message,
 *  `conversationId` is the *parent* and `threadParentSeq` is the parent message
 *  whose thread panel should open (the seq then scrolls within that thread). */
export type PushPayload =
  | {
      type: 'message';
      conversationId: string;
      /** Channel within the conversation (equals `conversationId` for the
       *  general channel, in which case no extra path segment is added). */
      channelId: string;
      /** The new message's sequence number — used to scroll to/highlight it. */
      seq: number;
      /** Present only for a reply-thread message: the parent message seq whose
       *  thread panel should open (`conversationId` is then the parent). */
      threadParentSeq?: number;
    }
  | {
      // A reaction on one of my messages. Routes exactly like `message` (deep-
      // links to the reacted message); still content-free — never the emoji or
      // who reacted.
      type: 'reaction';
      conversationId: string;
      channelId: string;
      /** The reacted message's sequence number — used to scroll to/highlight it. */
      seq: number;
      threadParentSeq?: number;
    }
  | { type: 'call'; conversationId: string }
  // v8 sealed-mailbox wake (D7): fully content-free — no conversation, sender, or
  // routing (the relay is zero-at-rest + sealed-sender). Just tells a device to
  // drain its mailbox.
  | { type: 'mail' };

// Public-handle generation + validation (shared by server + native client).
export * from './handles.js';
