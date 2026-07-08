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

// ---- first-run legacy import (spec/migration.md) ----
// The webview decrypts with the existing v1 crypto and streams plaintext
// batches to the core; each call is transactional and idempotent, so the
// migrator can resume after a partial failure by re-sending.

export interface ImportNote {
  id: string;
  title: string | null;
  search_text: string | null;
  folder_id: string | null;
  created: number;
  updated: number;
  /** Yjs doc binary (Y.encodeStateAsUpdate) seeded from the legacy note. */
  ydoc_state: number[];
  /** `{ owner, access }` JSON for shared-with-me notes; null for own notes. */
  shared_json: string | null;
  /** The note's E2E key (unwrapped/unsealed during migration; phase-4 sync). */
  note_key: number[] | null;
  /** JSON string[] of the note's tags. */
  tags_json: string | null;
}

export interface ImportConversation {
  id: string;
  type: 'dm' | 'group';
}

export interface ImportContact {
  id: string;
  display_name: string | null;
  is_friend: boolean;
}

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

export function importNotes(batch: ImportNote[]): Promise<number> {
  return invoke<number>('import_notes', { batch });
}

export interface ImportNoteVersion {
  note_id: string;
  kind: 'legacy';
  name: string | null;
  created: number;
  /** JSON `{title, body}` snapshot bytes. */
  snapshot: number[];
}

export function importNoteVersions(batch: ImportNoteVersion[]): Promise<number> {
  return invoke<number>('import_note_versions', { batch });
}

export function importConversations(batch: ImportConversation[]): Promise<number> {
  return invoke<number>('import_conversations', { batch });
}

export function importContacts(batch: ImportContact[]): Promise<number> {
  return invoke<number>('import_contacts', { batch });
}

export function importMessages(batch: ImportMessage[]): Promise<number> {
  return invoke<number>('import_messages', { batch });
}
