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

/** A person you can share a note with — always one of your friends. Carries the
 *  display name (never the username) and their key to seal the note key to. */
export interface MemberInfo {
  id: string;
  displayName: string;
  publicKey: string | null;
}

export interface ShareInfo {
  noteId: string;
  recipientId: string;
  recipientDisplayName: string;
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
  ownerDisplayName: string;
  access: ShareAccess;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// v3 — E2EE chat (phase 1: friends + 1:1 DMs). The server only ever sees the
// ciphertext/sealed forms; conversation keys and message content stay E2E.
// ---------------------------------------------------------------------------

/** A reusable, 24h friend invite code. Hard-purged from the server on expiry. */
export interface FriendInvite {
  id: string;
  /** opaque random code shared out-of-band */
  token: string;
  createdAt: number;
  expiresAt: number;
}

/** A pending friend request, from the perspective of the current user. */
export interface FriendRequest {
  id: string;
  /** the *other* party (sender if incoming, recipient if outgoing) */
  userId: string;
  displayName: string;
  direction: 'incoming' | 'outgoing';
  createdAt: number;
}

/** A confirmed friend. publicKey is needed to seal conversation keys to them. */
export interface Friend {
  userId: string;
  displayName: string;
  /** base64 X25519 public key */
  publicKey: string | null;
  online: boolean;
}

export type ConversationKind = 'dm' | 'group' | 'thread';

/** A member's standing in a group. `owner` is the creator (exactly one);
 *  `admin` is a delegated manager with the same powers as the owner (add/remove
 *  members, grant/revoke admin) — except an admin can never remove the owner.
 *  `member` is everyone else. DMs/threads are always plain `member`. */
export type ConversationRole = 'owner' | 'admin' | 'member';

/** Pure authorization rule shared by client (UI affordances) and server
 *  (enforcement): may a member with `role` manage membership? Owners and admins
 *  can; plain members cannot. (Removing the owner is blocked separately.) */
export function canManageMembers(role: ConversationRole): boolean {
  return role === 'owner' || role === 'admin';
}

export interface ConversationMember {
  userId: string;
  displayName: string;
  /** base64 X25519 public key */
  publicKey: string | null;
  /** chosen name color (a NAME_COLORS value), or null for the default */
  nameColor: string | null;
  /** whether this member has link previews enabled — a preview is only generated
   *  when EVERY member has it on. */
  linkPreviews: boolean;
  /** standing in the group (owner/admin/member); always 'member' for DMs/threads */
  role: ConversationRole;
}

/** Curated name-color palette: the `--brand-*` accents, each defined in CSS as a
 *  light-dark() pair, so any choice stays readable in every theme. Stored as the
 *  color name and rendered as `var(--brand-<name>)`; null = default text color.
 *  Restricting to this set (no free picker) is what guarantees readability. */
export const NAME_COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const;
export type NameColor = (typeof NAME_COLORS)[number];

/** A conversation as returned to one of its members, including that member's
 * own sealed copy of the current-epoch conversation key. */
export interface Conversation {
  id: string;
  kind: ConversationKind;
  members: ConversationMember[];
  /** the conversation key sealed to ME (current epoch) — unseal with my X25519 key */
  sealedKey: SealedKey;
  epoch: number;
  /** EVERY epoch key sealed to me (one per epoch I can read, including the
   *  current one). A group re-keys on each membership change; to decrypt the
   *  full back-scroll a client unseals all of these, keyed by epoch. */
  epochKeys: SealedEpochKey[];
  /** my role in this conversation */
  myRole: ConversationRole;
  /** highest message seq in the conversation (0 when empty) */
  lastSeq: number;
  /** my last-read seq; unread count = lastSeq - lastReadSeq */
  lastReadSeq: number;
  createdAt: number;
  /** for a thread (`kind: 'thread'`): the parent conversation it hangs off */
  parentId?: string | null;
  /** for a thread: the parent message seq it's rooted on */
  parentSeq?: number | null;
}

/** One chat message. ciphertext/iv are opaque to the server. */
export interface ChatMessage {
  conversationId: string;
  /** monotonic per-conversation sequence, assigned by the server */
  seq: number;
  senderId: string;
  epoch: number;
  /** base64 AES-256-GCM ciphertext of a JSON MessagePayload */
  ciphertext: string;
  /** base64 12-byte IV */
  iv: string;
  /** server-receipt time (metadata) */
  createdAt: number;
  /** server time of the last edit (metadata); absent if never edited */
  editedAt?: number;
}

/** One reaction on a message. The emoji is encrypted with the conversation key
 *  (`ciphertext`/`iv`), so the server can't read which emoji was used; clients
 *  decrypt and aggregate. The server keys a reaction by its own `id`. */
export interface ChatReaction {
  id: string;
  conversationId: string;
  /** the reacted message's per-conversation seq */
  seq: number;
  userId: string;
  /** base64 AES-256-GCM ciphertext of a JSON ReactionPayload */
  ciphertext: string;
  iv: string;
  createdAt: number;
}

/** What the client encrypts into a reaction blob. */
export interface ReactionPayload {
  /** the emoji: a unicode char, `:emote:`, or `:customName:` */
  emoji: string;
}

/** A GIF chosen from KLIPY search, embedded inside the encrypted message so the
 *  server never learns which GIF was sent. The animated media lives on KLIPY's
 *  CDN (`url`); the recipient loads it from there (a documented third-party
 *  metadata tradeoff — see spec/security.md). */
export interface GifRef {
  provider: 'klipy';
  /** provider id/slug (attribution / dedupe) */
  id: string;
  /** animated media URL to render (webp preferred, gif fallback) */
  url: string;
  /** still/animated thumbnail URL for the picker grid */
  previewUrl: string;
  width: number;
  height: number;
  title?: string;
}

/** An inline, non-chat event (e.g. someone joined). Carried inside the encrypted
 *  `MessagePayload` like any message — so the server never sees it — and rendered
 *  as a centered system notice instead of a normal bubble. */
export interface SystemEvent {
  kind: 'member-joined';
  /** the user the event is about */
  userId: string;
  /** index into the client's join-phrase list (keeps a message's funny line
   *  stable for everyone, while the display name resolves live) */
  phrase: number;
}

/** What the client encrypts into a message blob (extensible in v3.1). */
export interface MessagePayload {
  /** markdown text (may be empty when the message is purely a GIF/attachment) */
  text: string;
  /** the sender's own clock (server time is separate metadata) */
  sentAt: number;
  /** a system notice (member joined, …) rendered inline instead of as a bubble */
  system?: SystemEvent;
  /** an embedded GIF (KLIPY search) — v3.1 */
  gif?: GifRef;
  /** encrypted file/image attachments. Each carries its own random AES key, so
   *  storing the ref inside this (conversation-key-encrypted) payload means only
   *  conversation members can decrypt the blob — same shape as NotePayload. */
  attachments?: AttachmentRef[];
  /** a reply to an earlier message. The parent `seq` plus a sender + text
   *  snapshot are embedded (encrypted) so the quote renders even before the
   *  parent is loaded, and survives the parent being deleted/unreadable. */
  replyTo?: ReplyRef;
  /** custom emoji used in `text` (`:name:`), keyed by name. Each is an encrypted
   *  attachment ref so recipients (who don't have the sender's private emoji
   *  palette) can decrypt + render it. */
  customEmoji?: Record<string, AttachmentRef>;
  /** an Open Graph link preview the sender's client generated (only when every
   *  conversation member has link previews enabled). Embedded in the encrypted
   *  payload Signal-style, so the server only ever saw the URL at proxy time. */
  linkPreview?: LinkPreview;
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

/** One member's sealed key when creating a conversation or re-keying client-side. */
export interface SealedMemberKey {
  userId: string;
  sealedKey: SealedKey;
}

/** A conversation key for one epoch, sealed to a single recipient. Used to hand
 *  a member their full set of readable epoch keys, and to share prior-epoch keys
 *  to a joiner who's allowed back-scroll. */
export interface SealedEpochKey {
  epoch: number;
  sealedKey: SealedKey;
}

/** Public profile metadata (server-visible; usernames never exposed to others).
 *  `friendsOnly` is the visibility setting: when true the encrypted profile
 *  (bio/avatar) is only ever distributed to accepted friends. */
export interface ProfileInfo {
  displayName: string;
  nameColor: string | null;
  friendsOnly: boolean;
  /** opt-in (default off): generate link previews for my messages. A preview is
   *  only created when every member of the conversation has this enabled. */
  linkPreviews: boolean;
}

/** The owner-set, E2E-encrypted profile contents. Encrypted under a per-user
 *  **profile key** and embedded whole (avatar is a small optimized data URL),
 *  so the server never sees any of it. */
export interface ProfileData {
  bio?: string;
  /** small optimized avatar as a `data:image/webp` URL */
  avatar?: string;
}

/** AES-256-GCM ciphertext of a `ProfileData`, with the rotation epoch (bumped
 *  when a contact loses access so they can't read future updates). */
export interface ProfileCipher {
  ciphertext: string;
  iv: string;
  epoch: number;
}

/** The profile key sealed to one recipient's X25519 public key. */
export interface SealedProfileKey {
  recipientId: string;
  sealedKey: SealedKey;
}

/** What a viewer receives for another user's profile. `encrypted` is null when
 *  the viewer isn't a current recipient (not a friend, or visibility-restricted);
 *  in that case only the display name / color are shown. */
export interface ProfileView {
  userId: string;
  displayName: string;
  nameColor: string | null;
  encrypted: (ProfileCipher & { sealedKey: SealedKey }) | null;
}

// ---- WebSocket frame protocol (JSON frames over one authenticated socket) ----

/** Server -> client. The read path: live delivery + receipts + friend events. */
export type ServerFrame =
  | { type: 'hello'; userId: string }
  | { type: 'message'; message: ChatMessage }
  // A message's ciphertext was edited in place (same seq) — replace it locally.
  | { type: 'message-edited'; message: ChatMessage }
  | { type: 'reaction'; reaction: ChatReaction }
  | { type: 'reaction-removed'; conversationId: string; id: string }
  | { type: 'read'; conversationId: string; userId: string; seq: number }
  | { type: 'friend-request'; request: FriendRequest }
  | { type: 'friend-accepted'; friend: Friend }
  | { type: 'profile-updated'; userId: string }
  // A group's membership/roles/policy or epoch changed — refetch it to pick up
  // new members and any newly-sealed epoch keys.
  | { type: 'conversation-updated'; conversationId: string }
  // You were removed from (or left) a conversation — drop it locally.
  | { type: 'conversation-removed'; conversationId: string }
  | { type: 'presence'; userId: string; online: boolean };

/** Client -> server. Sends and read-markers go over REST; this stays minimal.
 * Liveness uses protocol-level ping/pong (browser auto-pongs), not app frames. */
export type ClientFrame = { type: 'ping' };
