// First-run legacy migration (spec/migration.md): pull everything from the
// v1 server, decrypt with the existing session crypto, and stream plaintext
// batches into the Rust core over the idempotent import IPC (native.ts).
//
// Runs only in the native shell, with BOTH the legacy session unlocked (MK in
// memory — the one-time server-verified bootstrap sign-in) and the local
// vault created/unlocked. Re-running after a partial failure is safe: every
// import command is INSERT OR IGNORE.
//
// Scope notes: shared-with-me notes and attachment blobs migrate in a later
// pass (attachments need the encrypted-FS layer); own notes, friends,
// conversations, and full message history land here.

import * as Y from 'yjs';
import { api } from './api';
import { decryptNotePayload } from './crypto';
import { decryptMessage, unsealConversationKey } from './chatCrypto';
import {
  importContacts,
  importConversations,
  importMessages,
  importNotes,
  type ImportMessage,
  type ImportNote,
} from './native';
import type { ChatMessage, Conversation, Friend, MessagePayload, NoteRecord } from '@notes/shared';

const NOTE_BATCH = 50;
const MESSAGE_PAGE = 200;

export interface MigrationProgress {
  stage: 'notes' | 'contacts' | 'conversations' | 'messages' | 'done';
  done: number;
  total: number | null;
  detail?: string;
}

export interface MigrationSummary {
  notes: number;
  contacts: number;
  conversations: number;
  messages: number;
}

/** Seed a Yjs doc from a legacy markdown body (the shape y-codemirror edits). */
export function noteBodyToYdocState(body: string): number[] {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, body);
  return Array.from(Y.encodeStateAsUpdate(doc));
}

export function toImportNote(record: NoteRecord, title: string, body: string, tags: string[]): ImportNote {
  return {
    id: record.id,
    title,
    // Tags ride in the search projection until the tag model is ported.
    search_text: tags.length ? `${body}\n${tags.join(' ')}` : body,
    folder_id: null, // folders are personal-organization settings; ported with the settings blob
    created: record.createdAt,
    updated: record.updatedAt,
    ydoc_state: noteBodyToYdocState(body),
  };
}

export function toImportMessage(msg: ChatMessage, payload: MessagePayload): ImportMessage {
  const system = payload.system !== undefined;
  return {
    // Legacy messages predate sender-assigned ids (D11); compose a stable one.
    id: `legacy:${msg.conversationId}:${msg.seq}`,
    conversation_id: msg.conversationId,
    channel_id: msg.channelId === msg.conversationId ? null : msg.channelId,
    sender_contact_id: msg.senderId,
    relay_ts: msg.createdAt,
    content: payload.text || null,
    kind: system ? 'system' : 'text',
    reply_ref_json: payload.replyTo ? JSON.stringify(payload.replyTo) : null,
    attachments_json:
      payload.attachments?.length || payload.gif
        ? JSON.stringify({ attachments: payload.attachments ?? [], gif: payload.gif ?? null })
        : null,
    edited_at: null, // legacy edits already replaced the ciphertext in place
  };
}

async function migrateNotes(
  mk: Uint8Array,
  onProgress: (p: MigrationProgress) => void,
): Promise<number> {
  const { notes } = await api.notes(0);
  const live = notes.filter((n) => !n.deleted);
  let imported = 0;
  for (let i = 0; i < live.length; i += NOTE_BATCH) {
    const batch: ImportNote[] = [];
    for (const record of live.slice(i, i + NOTE_BATCH)) {
      const payload = await decryptNotePayload(mk, record);
      batch.push(toImportNote(record, payload.title, payload.body, payload.tags));
    }
    imported += await importNotes(batch);
    onProgress({ stage: 'notes', done: Math.min(i + NOTE_BATCH, live.length), total: live.length });
  }
  return imported;
}

async function migrateContacts(onProgress: (p: MigrationProgress) => void): Promise<number> {
  const friends: Friend[] = await api.friends();
  const imported = await importContacts(
    friends.map((f) => ({
      id: f.userId,
      display_name: f.displayName || f.handle,
      is_friend: true,
    })),
  );
  onProgress({ stage: 'contacts', done: friends.length, total: friends.length });
  return imported;
}

async function epochKeysFor(
  conv: Conversation,
  keyPair: { privateKey: Uint8Array; publicKey: Uint8Array },
): Promise<Map<number, Uint8Array>> {
  const keys = new Map<number, Uint8Array>();
  for (const ek of conv.epochKeys) {
    keys.set(
      ek.epoch,
      await unsealConversationKey(ek.sealedKey, keyPair.privateKey, keyPair.publicKey),
    );
  }
  return keys;
}

async function migrateConversation(
  conv: Conversation,
  keyPair: { privateKey: Uint8Array; publicKey: Uint8Array },
  onProgress: (p: MigrationProgress) => void,
): Promise<number> {
  const keys = await epochKeysFor(conv, keyPair);
  let imported = 0;
  let before: number | undefined;
  for (;;) {
    const page = await api.conversationMessages(conv.id, { before, limit: MESSAGE_PAGE });
    if (page.length === 0) break;
    const batch: ImportMessage[] = [];
    for (const msg of page) {
      const key = keys.get(msg.epoch);
      if (!key) continue; // epoch predates my history floor — not mine to read
      try {
        batch.push(toImportMessage(msg, await decryptMessage(key, msg.ciphertext, msg.iv)));
      } catch {
        // Undecryptable rows (corrupt/foreign) are skipped, never fatal.
      }
    }
    imported += await importMessages(batch);
    before = Math.min(...page.map((m) => m.seq));
    onProgress({ stage: 'messages', done: imported, total: null, detail: conv.id });
    if (page.length < MESSAGE_PAGE) break;
  }
  return imported;
}

/**
 * Run the full pull-everything migration. Idempotent; safe to re-run.
 * Caller guards: native shell, legacy session unlocked, vault unlocked.
 */
export async function runLegacyMigration(
  mk: Uint8Array,
  keyPair: { privateKey: Uint8Array; publicKey: Uint8Array },
  onProgress: (p: MigrationProgress) => void = () => {},
): Promise<MigrationSummary> {
  const summary: MigrationSummary = { notes: 0, contacts: 0, conversations: 0, messages: 0 };

  summary.notes = await migrateNotes(mk, onProgress);
  summary.contacts = await migrateContacts(onProgress);

  const conversations = await api.conversations();
  summary.conversations = await importConversations(
    conversations.map((c) => ({ id: c.id, type: c.kind === 'dm' ? 'dm' : 'group' })),
  );
  onProgress({ stage: 'conversations', done: conversations.length, total: conversations.length });

  for (const conv of conversations) {
    summary.messages += await migrateConversation(conv, keyPair, onProgress);
  }

  onProgress({ stage: 'done', done: 1, total: 1 });
  return summary;
}
