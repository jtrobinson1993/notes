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

export function importConversations(batch: ImportConversation[]): Promise<number> {
  return invoke<number>('import_conversations', { batch });
}

export function importContacts(batch: ImportContact[]): Promise<number> {
  return invoke<number>('import_contacts', { batch });
}

export function importMessages(batch: ImportMessage[]): Promise<number> {
  return invoke<number>('import_messages', { batch });
}
