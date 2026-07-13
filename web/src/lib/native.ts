// Bridge to the Tauri Rust core (spec/local-store.md — the webview is UI only;
// keys and storage live in Rust and never cross this boundary).
//
// Every call here is a domain-level IPC command. In the browser (no Tauri)
// `isNative` is false and none of these functions may be called — callers
// branch on `isNative` and keep using the web paths (IndexedDB/session flows)
// until those are retired at the v8 cutover.

import { invoke, isTauri } from '@tauri-apps/api/core';

/** True when running inside the Tauri shell (any platform). */
export const isNative: boolean = isTauri();

export type VaultStatus = 'uninitialized' | 'locked' | 'unlocked';

export function vaultStatus(): Promise<VaultStatus> {
  return invoke<VaultStatus>('vault_status');
}

/**
 * First-run setup: generates the D13 key set (MK, SQLCipher key, vault key)
 * and resolves with the recovery code — display it once, never persist it.
 */
export function vaultCreate(password: string): Promise<string> {
  return invoke<string>('vault_create', { password });
}

/** Primary unlock (D3): OS keychain, no user secret (biometric-gated later). */
export function vaultUnlockKeychain(): Promise<void> {
  return invoke('vault_unlock_keychain');
}

/** Portable fallback unlock: password unwraps MK. */
export function vaultUnlock(password: string): Promise<void> {
  return invoke('vault_unlock', { password });
}

/** Break-glass unlock: recovery code (case/separator-insensitive). */
export function vaultUnlockRecovery(code: string): Promise<void> {
  return invoke('vault_unlock_recovery', { code });
}

/**
 * Cold-start restore on a fresh, unpaired device (D15/D3a): fetch the
 * wrapped-MK escrow from a relay by handle + password and rebuild the vault.
 * Restores identity, not history (pair a device or import a backup for that).
 */
export function vaultRestoreFromEscrow(
  url: string,
  handle: string,
  password: string,
): Promise<void> {
  return invoke('vault_restore_from_escrow', { url, handle, password });
}

export function vaultLock(): Promise<void> {
  return invoke('vault_lock');
}

/** Local (device-only) settings stored in the encrypted vault DB. */
export function settingsGet(key: string): Promise<string | null> {
  return invoke<string | null>('settings_get', { key });
}

export function settingsSet(key: string, value: string): Promise<void> {
  return invoke('settings_set', { key, value });
}

// ---- multi-account (each account = its own vault; switching restarts the app) ----

export interface AccountEntry {
  id: string;
  /** The account's public handle, once onboarded (else a placeholder). */
  label: string;
  dir: string;
}
export interface AccountRegistry {
  active: string;
  accounts: AccountEntry[];
}

/** The accounts on this device + which is active. */
export function accountList(): Promise<AccountRegistry> {
  return invoke<AccountRegistry>('account_list');
}

/** Switch to another account (restarts the app into its vault). */
export function accountSwitch(id: string): Promise<void> {
  return invoke('account_switch', { id });
}

/** Add a new empty account + switch to it (restart lands on onboarding). */
export function accountAdd(): Promise<void> {
  return invoke('account_add');
}

/** Label the active account with its handle (after onboarding / handle change). */
export function accountSetLabel(label: string): Promise<void> {
  return invoke('account_set_label', { label });
}

// ---- relay auth (D4/D4b client half) ----

/** This device's Ed25519 public key (created on first use, keychain-held). */
export function devicePublicKey(): Promise<string> {
  return invoke<string>('device_public_key');
}

/** Handshake with a relay: pin its fingerprint, prove the device key, hold a
 *  silently-refreshing bearer token in the core. */
export function relayConnect(url: string): Promise<void> {
  return invoke('relay_connect', { url });
}

/** Create this device's account on a relay and enroll the device in one call,
 *  leaving the core authenticated (no separate `relayConnect` needed). Pass the
 *  bare invite `token` on an invite-only relay (omit for public/first account).
 *  Resolves with the server-assigned handle. */
export function relayRegister(url: string, inviteToken?: string, handle?: string): Promise<string> {
  return invoke<string>('relay_register', {
    url,
    inviteToken: inviteToken ?? null,
    handleChoice: handle ?? null,
  });
}

/** Invite signups only: deliver the sealed friend-accept to the inviter (the
 *  follow-up leg of the D4b handshake). Resolves with whether it was delivered. */
export function relayRegisterFriendAccept(envelope: number[]): Promise<boolean> {
  return invoke<boolean>('relay_register_friend_accept', { envelope });
}

/** Upload the wrapped-MK escrow bundle to the connected relay (D15). */
export function relayEscrowUpload(): Promise<void> {
  return invoke('relay_escrow_upload');
}

/** Derive + publish this account's per-relay keys to the directory (D5). */
export function relayDirectoryPublish(): Promise<void> {
  return invoke('relay_directory_publish');
}

/** Mint a friend invite (D4b): store hash(token) + expiry; resolves with the
 *  absolute expiry (ms). The raw token stays client-side (goes in the invite). */
export function relayInviteMint(tokenHash: string, expiresInSec?: number): Promise<number> {
  return invoke<number>('relay_invite_mint', { tokenHash, expiresInSec: expiresInSec ?? null });
}

/** Redeem a friend invite: drop the pre-sealed friend-accept envelope into the
 *  inviter's mailbox (capability only). Resolves with the relay stamp. */
export function relayInviteRedeem(token: string, envelope: number[]): Promise<number> {
  return invoke<number>('relay_invite_redeem', { token, envelope });
}

/** This account's per-relay directory keys (base64) for assembling an invite. */
export function relayMyDirectoryKeys(): Promise<{ identity_pub: string; sealing_pub: string }> {
  return invoke('relay_my_directory_keys');
}

// ---- friends (D4b) ----

export interface FriendSummary {
  contact_id: string;
  handle: string;
  display_name: string | null;
  /** STANDARD base64 of the friend's Ed25519 identity key (maps an inbound
   *  call's verified callerId, which uses the same encoding, to this friend). */
  identity_pub: string;
}

export interface FriendAddressing {
  handle: string;
  /** Friend's Ed25519 identity key (raw bytes). */
  identity_pub: number[];
  /** Friend's X25519 sealing key (raw bytes) — seal envelopes to this. */
  sealing_pub: number[];
  /** Capability to send to the friend via the sealed mailbox. */
  delivery_token: string;
}

/** v8 friends on the connected relay (friends list + starting DMs). */
export function friendsList(): Promise<FriendSummary[]> {
  return invoke<FriendSummary[]>('friends_list');
}

/** A friend's addressing (seal + send), or null if not a friend here. */
export function friendAddressing(contactId: string): Promise<FriendAddressing | null> {
  return invoke('friend_addressing', { contactId });
}

/** Unfriend (local half): drop the friend flag + addressing. */
export function friendRemove(contactId: string): Promise<void> {
  return invoke('friend_remove', { contactId });
}

/** Register hash(delivery token) with the relay; resolves with the token
 *  itself, which gets sealed to friends (D6). */
export function relayRegisterVerifier(): Promise<string> {
  return invoke<string>('relay_register_verifier');
}

/** Change my public handle to a picked generated candidate (Word#1234). Resolves
 *  with the server-confirmed handle (persisted locally by the core). */
export function relayChangeHandle(handle: string): Promise<string> {
  return invoke<string>('relay_change_handle', { handle });
}

/**
 * Send a v8 text message to a friend (D6/D11): the core derives the DM
 * conversation id (both sides compute the same one), composes + seals the
 * payload, delivers it via the friend's delivery token, and tees the same id
 * into the local log so it renders immediately. Resolves with the message id.
 */
export function relaySendMessage(
  contactId: string,
  content: string,
  attachmentsJson?: string,
): Promise<string> {
  return invoke<string>('relay_send_message', {
    contactId,
    content,
    attachmentsJson: attachmentsJson ?? null,
  });
}

/** Delete a v8 message I sent (D11 tombstone): seals a delete to the friend and
 *  tombstones my local copy. The recipient applies it only because the delete's
 *  verified sender matches the message's author. */
export function relayDeleteMessage(contactId: string, messageId: string): Promise<void> {
  return invoke('relay_delete_message', { contactId, messageId });
}

/** An attachment ref embedded in a message payload: the relay blobId + the
 *  per-file key/iv (never seen by the relay) + display metadata. */
export interface MessageAttachment {
  blobId: string;
  key: string;
  iv: string;
  mime: string;
  name: string;
  size: number;
}

/** Encrypt + upload a file to the blob store (D6). `kind` picks DM (friend's
 *  delivery token) vs group (group token). Resolves with the ref to attach. */
export function attachmentUpload(
  kind: 'dm' | 'group',
  targetId: string,
  bytes: number[],
  mime: string,
  name: string,
): Promise<MessageAttachment> {
  return invoke<MessageAttachment>('attachment_upload', { kind, targetId, bytes, mime, name });
}

/** Download + decrypt an attachment (D6); resolves with the plaintext bytes. */
export function attachmentFetch(
  kind: 'dm' | 'group',
  targetId: string,
  attachment: MessageAttachment,
): Promise<number[]> {
  return invoke<number[]>('attachment_fetch', { kind, targetId, attachment });
}

/** Edit a v8 message I sent (D11): seals an edit to the friend and updates my
 *  local copy. The recipient applies it only if my verified identity is the
 *  message's author. */
export function relayEditMessage(contactId: string, messageId: string, content: string): Promise<void> {
  return invoke('relay_edit_message', { contactId, messageId, content });
}

export interface ReactionRow {
  message_id: string;
  emoji: string;
  /** `self` for mine, else the reactor's identity key. */
  reactor_id: string;
}

/** React to a v8 message (D11): seals the reaction to the friend + applies it
 *  locally. `add` toggles add vs remove. */
export function relayReact(
  contactId: string,
  messageId: string,
  emoji: string,
  add: boolean,
): Promise<void> {
  return invoke('relay_react', { contactId, messageId, emoji, add });
}

/** The caller's view of a placed ring: the call id to `join` + the base64 frame
 *  key it minted (also sealed to the callee inside the offer). */
export interface PlacedCall {
  callId: string;
  mediaKey: string;
}

/** Place a voice call ring (v8 voice): mints a call id + frame key, seals a
 *  call-offer into the friend's mailbox, returns both (caller sets its send
 *  frame key from `mediaKey` and joins `callId`). */
export function relayCallOffer(contactId: string): Promise<PlacedCall> {
  return invoke<PlacedCall>('relay_call_offer', { contactId });
}

/** Join a call's signaling room so the relay starts relaying peer frames. */
export function voiceJoin(callId: string): Promise<void> {
  return invoke('voice_join', { callId });
}

/** Send an opaque (E2E-sealed) SDP/ICE payload to the call's peers. */
export function voiceSignal(callId: string, payload: unknown): Promise<void> {
  return invoke('voice_signal', { callId, payload });
}

/** Leave a call's signaling room (hangup). */
export function voiceLeave(callId: string): Promise<void> {
  return invoke('voice_leave', { callId });
}

/** All reactions on a conversation's messages (the UI groups by emoji). */
export function conversationReactions(conversationId: string): Promise<ReactionRow[]> {
  return invoke<ReactionRow[]>('conversation_reactions', { conversationId });
}

/** Delete a message I sent in a group (D11): fans out a delete + tombstones local. */
export function relayGroupDeleteMessage(groupId: string, messageId: string): Promise<void> {
  return invoke('relay_group_delete_message', { groupId, messageId });
}

/** Edit a message I sent in a group (D11): fans out an edit + updates local. */
export function relayGroupEditMessage(groupId: string, messageId: string, content: string): Promise<void> {
  return invoke('relay_group_edit_message', { groupId, messageId, content });
}

/** React to a group message (D11): fans out the reaction + applies local. */
export function relayGroupReact(
  groupId: string,
  messageId: string,
  emoji: string,
  add: boolean,
): Promise<void> {
  return invoke('relay_group_react', { groupId, messageId, emoji, add });
}

/** The deterministic v8 DM conversation id for a friend (both sides agree). */
export function dmConversationId(contactId: string): Promise<string> {
  return invoke<string>('dm_conversation_id_for', { contactId });
}

/** Mark a DM read up to its newest message (local unread tracking). */
export function dmMarkRead(conversationId: string): Promise<void> {
  return invoke('dm_mark_read', { conversationId });
}

/** Unread inbound message count for a DM conversation. */
export function dmUnread(conversationId: string): Promise<number> {
  return invoke<number>('dm_unread', { conversationId });
}

/** A conversation's activity: newest message stamp (0 = no messages yet) + unread. */
export interface ConversationActivity {
  conversation_id: string;
  last_ts: number;
  unread: number;
}

/** Every conversation's activity in one call — what the sidebar orders by. */
export function conversationActivity(): Promise<ConversationActivity[]> {
  return invoke<ConversationActivity[]>('conversation_activity');
}

// ---- groups (D14) ----

export interface GroupSummary {
  group_id: string;
  name: string | null;
}

/** Create a group I own (D14): publishes the genesis record + verifier and
 *  stores the group key. Resolves with the group id. Add members separately. */
export function groupCreate(name: string): Promise<string> {
  return invoke<string>('group_create', { name });
}

/** Groups I'm a member of. */
export function groupList(): Promise<GroupSummary[]> {
  return invoke<GroupSummary[]>('group_list');
}

/** Add a friend to a group I administer (D14): update the signed record + hand
 *  them the group key via a sealed group-invite. */
export function groupAddMember(groupId: string, contactId: string): Promise<void> {
  return invoke('group_add_member', { groupId, contactId });
}

/** Send a text to a group (D6/D14): the core seals one envelope under the group
 *  key, the relay fans it to all members, and it tees locally. Resolves with the
 *  message id. */
export function relaySendGroupMessage(
  groupId: string,
  content: string,
  attachmentsJson?: string,
): Promise<string> {
  return invoke<string>('relay_send_group_message', {
    groupId,
    content,
    attachmentsJson: attachmentsJson ?? null,
  });
}

/** Sealed send: the recipient's delivery token is the only credential. */
export function relaySend(
  recipientHandle: string,
  deliveryToken: string,
  envelope: number[],
): Promise<number> {
  return invoke<number>('relay_send', { recipientHandle, deliveryToken, envelope });
}

/** Seal an E2E envelope (v1) to a recipient's sealing key. */
export function envelopeSeal(
  recipientSealingPub: string,
  kind: string,
  payload: number[],
): Promise<number[]> {
  return invoke<number[]>('envelope_seal', { recipientSealingPub, kind, payload });
}

/** Open an envelope addressed to this account; sender key is verified
 *  against the content signature (check it against the directory too). */
export function envelopeOpen(envelopeBytes: number[]): Promise<{
  kind: string;
  payload: number[];
  sender_identity_pub: string;
  sent_at: number;
}> {
  return invoke('envelope_open', { envelopeBytes });
}

export function relayMailboxFetch(): Promise<
  { queue_id: number; relay_ts: number; envelope: number[] }[]
> {
  return invoke('relay_mailbox_fetch');
}

/** Ack only after the envelopes are durably ingested (hold-until-ack). */
export function relayMailboxAck(queueIds: number[]): Promise<number> {
  return invoke<number>('relay_mailbox_ack', { queueIds });
}

export interface DrainReport {
  /** Rows newly inserted into the local log (idempotent — dupes not counted). */
  ingested: number;
  /** Queue entries removed (ingested + permanently-invalid discards). */
  acked: number;
  /** Queue entries left in place for a post-update retry (version skew). */
  buffered: number;
  /** Friends recorded from verified friend-accept/confirm envelopes (D4b). */
  friends: number;
  /** Incoming voice call rings from verified call-offer envelopes (v8 voice). */
  calls?: CallRing[];
}

/** An incoming voice call ring surfaced by the drain (v8 voice). */
export interface CallRing {
  /** The call id to `join` on the signaling socket to answer. */
  callId: string;
  /** The verified caller's identity pubkey (map to a contact for display). */
  callerId: string;
  /** Relay delivery stamp — drop a ring too old to still be live. */
  relayTs: number;
  /** base64 frame key for the call's E2EE (sealed to us inside the offer). */
  mediaKey: string;
}

/**
 * One-shot mailbox drain (D6/D11): fetch queued envelopes, open+verify each,
 * decode `msg` payloads, ingest idempotently into the local log (ordering =
 * relay delivery stamp; sender = the verified envelope cert), then ack what was
 * stored or is permanently unusable. Version-skew / unhandled kinds are left
 * queued to redeliver after an update. Safe to call repeatedly — triggered by
 * the `relay:mail` live nudge and on reconnect.
 */
export function relayMailboxDrain(): Promise<DrainReport> {
  return invoke<DrainReport>('relay_mailbox_drain');
}

/** Result of a KT self-audit (D5): whether the relay's log only bound my handle
 *  to keys I minted + its roots are consistent. `reason` is the alarm on failure
 *  ("self-audit-failed" | "split-view"). */
export interface KtAuditReport {
  ok: boolean;
  reason: string | null;
  epoch: number;
}

/** Self-audit my own handle against the relay's KT log (full-AKD). Also emits a
 *  `kt:alarm` event on failure (see nativeKt). */
export function ktSelfAudit(): Promise<KtAuditReport> {
  return invoke<KtAuditReport>('kt_self_audit');
}

/** Gossip my latest signed KT root to a friend so they can detect a split view
 *  (D5). Best-effort — call opportunistically (e.g. after messaging them). */
export function ktGossipSend(contactId: string): Promise<void> {
  return invoke('kt_gossip_send', { contactId });
}

export function relayStatus(): Promise<{
  connected: boolean;
  base_url: string | null;
  relay_fp: string | null;
}> {
  return invoke('relay_status');
}

// ---- chat history (local log, D11) ----

export interface MessageRow {
  id: string;
  conversation_id: string;
  channel_id: string | null;
  sender_contact_id: string | null;
  relay_ts: number;
  content: string | null;
  kind: string;
  reply_ref_json: string | null;
  attachments_json: string | null;
  deleted: boolean;
  edited_at: number | null;
}

/** Page history backwards; `before` = `(relay_ts, id)` of the oldest row of
 *  the previous page (exclusive), undefined for the newest page. */
export function messagesPage(
  conversationId: string,
  channelId: string | null,
  before: { ts: number; id: string } | undefined,
  limit: number,
): Promise<MessageRow[]> {
  return invoke<MessageRow[]>('messages_page', {
    conversationId,
    channelId,
    beforeTs: before?.ts ?? null,
    beforeId: before?.id ?? null,
    limit,
  });
}

/** Write live traffic into the local log (idempotent by message id). */
export function messagesIngest(batch: ImportMessage[]): Promise<number> {
  return invoke<number>('messages_ingest', { batch });
}

export function messageEdit(id: string, content: string | null, editedAt: number): Promise<void> {
  return invoke('message_edit', { id, content, editedAt });
}

export function messageDelete(id: string): Promise<void> {
  return invoke('message_delete', { id });
}

// ---- notes CRUD (local-first read/write path, D2) ----

export interface NoteMeta {
  id: string;
  title: string | null;
  folder_id: string | null;
  /** `{ owner, access }` for shared-with-me notes; null for own notes. */
  shared_json: string | null;
  /** JSON string[] of tags. */
  tags_json: string | null;
  created: number;
  updated: number;
}

export interface NoteDoc {
  meta: NoteMeta;
  ydoc_state: number[] | null;
}

export function notesList(): Promise<NoteMeta[]> {
  return invoke<NoteMeta[]>('notes_list');
}

/** Startup bulk load: every note's meta + Y.Doc state in one IPC call. */
export function notesLoadAll(): Promise<NoteDoc[]> {
  return invoke<NoteDoc[]>('notes_load_all');
}

export function noteGet(id: string): Promise<NoteDoc> {
  return invoke('note_get', { id });
}

export function noteCreate(id: string): Promise<void> {
  return invoke('note_create', { id });
}

/** Persist an edit: full encoded Y.Doc state + title + tags + search text. */
export function noteSave(
  id: string,
  title: string,
  searchText: string,
  tagsJson: string,
  ydocState: number[],
): Promise<void> {
  return invoke('note_save', { id, title, searchText, tagsJson, ydocState });
}

export function noteDelete(id: string): Promise<void> {
  return invoke('note_delete', { id });
}

export function notesSearch(query: string): Promise<NoteMeta[]> {
  return invoke<NoteMeta[]>('notes_search', { query });
}

// ---- attachments (ciphertext blobs on the native filesystem) ----

export interface AttachmentMeta {
  id: string;
  owner_kind: 'message' | 'note';
  owner_id: string;
  /** Per-file key from the E2E payload (rests in the SQLCipher DB). */
  file_key: number[];
  /** AES-GCM IV for the blob (legacy refs carry it separately). */
  iv: number[] | null;
  thumb: number[] | null;
  size: number | null;
  mime: string | null;
  content_hash: string | null;
}

export interface AttachmentRow extends Omit<AttachmentMeta, 'owner_kind'> {
  owner_kind: string;
  state: 'present' | 'evicted' | 'expired';
}

/** Store attachment ciphertext exactly as it travels; idempotent. */
export function attachmentPut(meta: AttachmentMeta, bytes: number[]): Promise<void> {
  return invoke('attachment_put', { meta, bytes });
}

/** Fetch meta + ciphertext; `bytes` is null when evicted/expired. */
export function attachmentGet(
  id: string,
): Promise<{ meta: AttachmentRow; bytes: number[] | null }> {
  return invoke('attachment_get', { id });
}

/** Cheap existence probe (used by the migrator to skip re-downloads). */
export function attachmentHas(id: string): Promise<boolean> {
  return invoke<boolean>('attachment_has', { id });
}

/** Local space reclamation (D6 retention) — this device only. */
export function attachmentEvict(id: string): Promise<void> {
  return invoke('attachment_evict', { id });
}

/** A message row for the local log — used by the live-ingest path
 *  (`messagesIngest`) that keeps the log current with new traffic. */
export interface ImportMessage {
  id: string;
  conversation_id: string;
  channel_id: string | null;
  sender_contact_id: string | null;
  relay_ts: number;
  content: string | null;
  kind: string;
  reply_ref_json: string | null;
  attachments_json: string | null;
  edited_at: number | null;
}

