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
import { decryptNotePayload, decryptSharedNotePayload, unwrapKey, unwrapNoteKey } from './crypto';
import { decryptMessage, unsealConversationKey } from './chatCrypto';
import { decryptProfile, unwrapProfileKey } from './profileCrypto';
import { b64 } from './b64';
import {
  attachmentHas,
  attachmentPut,
  importContacts,
  importConversations,
  importMessages,
  importNotes,
  importNoteVersions,
  settingsSet,
  type ImportMessage,
  type ImportNote,
  type ImportNoteVersion,
} from './native';
import { ub64 } from './b64';
import type {
  AttachmentRef,
  ChatMessage,
  Conversation,
  Friend,
  MessagePayload,
  NoteRecord,
} from '@notes/shared';

const NOTE_BATCH = 50;
const MESSAGE_PAGE = 200;

export interface MigrationProgress {
  stage:
    | 'notes'
    | 'shared-notes'
    | 'versions'
    | 'settings'
    | 'contacts'
    | 'conversations'
    | 'messages'
    | 'attachments'
    | 'done';
  done: number;
  total: number | null;
  detail?: string;
}

export interface MigrationSummary {
  notes: number;
  sharedNotes: number;
  noteVersions: number;
  orgSettings: boolean;
  profile: boolean;
  contacts: number;
  conversations: number;
  messages: number;
  attachments: number;
}

/** An attachment ref discovered during the note/message passes, remembered
 *  with its owner so the blob pass can download after the cheap passes. */
interface PendingBlob {
  ref: Pick<AttachmentRef, 'id' | 'key' | 'iv' | 'type' | 'size'>;
  ownerKind: 'message' | 'note';
  ownerId: string;
}

export function collectBlobRefs(
  attachments: AttachmentRef[] | undefined,
  ownerKind: 'message' | 'note',
  ownerId: string,
): PendingBlob[] {
  const out: PendingBlob[] = [];
  for (const ref of attachments ?? []) {
    out.push({ ref, ownerKind, ownerId });
    // A video's poster is its own separately-encrypted blob.
    if (ref.poster) {
      out.push({ ref: { ...ref.poster, size: 0 }, ownerKind, ownerId });
    }
  }
  return out;
}

/** Seed a Yjs doc from a legacy markdown body (the shape y-codemirror edits). */
export function noteBodyToYdocState(body: string): number[] {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, body);
  return Array.from(Y.encodeStateAsUpdate(doc));
}

export function toImportNote(
  record: Pick<NoteRecord, 'id' | 'createdAt' | 'updatedAt'>,
  title: string,
  body: string,
  tags: string[],
  extras: { sharedJson?: string; noteKey?: Uint8Array } = {},
): ImportNote {
  return {
    id: record.id,
    title,
    // Tags ride in the search projection until the tag model is ported.
    search_text: tags.length ? `${body}\n${tags.join(' ')}` : body,
    // Folder assignment stays in the org settings blob (migrated as
    // `org.data`), same as the live app — folder_id is not materialized.
    folder_id: null,
    created: record.createdAt,
    updated: record.updatedAt,
    ydoc_state: noteBodyToYdocState(body),
    shared_json: extras.sharedJson ?? null,
    note_key: extras.noteKey ? Array.from(extras.noteKey) : null,
    tags_json: JSON.stringify(tags),
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
  pending: PendingBlob[],
  onProgress: (p: MigrationProgress) => void,
): Promise<{ imported: number; ids: string[] }> {
  const { notes } = await api.notes(0);
  const live = notes.filter((n) => !n.deleted);
  let imported = 0;
  for (let i = 0; i < live.length; i += NOTE_BATCH) {
    const batch: ImportNote[] = [];
    for (const record of live.slice(i, i + NOTE_BATCH)) {
      const payload = await decryptNotePayload(mk, record);
      const noteKey = await unwrapNoteKey(mk, record.wrappedKey);
      batch.push(toImportNote(record, payload.title, payload.body, payload.tags, { noteKey }));
      pending.push(...collectBlobRefs(payload.attachments, 'note', record.id));
    }
    imported += await importNotes(batch);
    onProgress({ stage: 'notes', done: Math.min(i + NOTE_BATCH, live.length), total: live.length });
  }
  return { imported, ids: live.map((n) => n.id) };
}

async function migrateSharedNotes(
  keyPair: { privateKey: Uint8Array; publicKey: Uint8Array },
  pending: PendingBlob[],
  onProgress: (p: MigrationProgress) => void,
): Promise<number> {
  const records = await api.sharedNotes();
  const batch: ImportNote[] = [];
  for (const record of records) {
    try {
      const { payload, noteKeyRaw } = await decryptSharedNotePayload(
        keyPair.privateKey,
        keyPair.publicKey,
        record,
      );
      batch.push(
        toImportNote(record, payload.title, payload.body, payload.tags, {
          sharedJson: JSON.stringify({ owner: record.ownerDisplayName, access: record.access }),
          noteKey: noteKeyRaw,
        }),
      );
      pending.push(...collectBlobRefs(payload.attachments, 'note', record.id));
    } catch {
      // An unsealable shared note (revoked mid-flight) is skipped, not fatal.
    }
  }
  const imported = await importNotes(batch);
  onProgress({ stage: 'shared-notes', done: records.length, total: records.length });
  return imported;
}

const ORG_SETTING_KEY = 'notes-org'; // matches stores/organization.ts
const INFO_SETTINGS = 'notes:wrap:settings:v1';

async function migrateOrgSettings(mk: Uint8Array): Promise<boolean> {
  const remote = await api.settingGet(ORG_SETTING_KEY);
  if (!remote) return false;
  const pt = await unwrapKey(mk, JSON.parse(remote.data), INFO_SETTINGS);
  await settingsSet('org.data', new TextDecoder().decode(pt));
  return true;
}

/** Own profile (bio/avatar/display name) + the profile key. The key matters
 *  beyond the blob: it becomes the D6 delivery-token access root in v8. */
async function migrateOwnProfile(mk: Uint8Array): Promise<boolean> {
  const { profile } = await api.profileDataGet();
  if (!profile) return false;
  const profileKey = await unwrapProfileKey(mk, profile.ownerWrappedKey);
  const data = await decryptProfile(profileKey, profile.ciphertext, profile.iv);
  await settingsSet('profile.own', JSON.stringify(data));
  await settingsSet('profile.key', b64(profileKey));
  await settingsSet('profile.epoch', String(profile.epoch));
  return true;
}

/** D10: best-effort import of legacy server version snapshots as read-only
 *  `legacy` versions. Only own notes have server versions. */
async function migrateNoteVersions(
  mk: Uint8Array,
  noteIds: string[],
  onProgress: (p: MigrationProgress) => void,
): Promise<number> {
  let imported = 0;
  let done = 0;
  for (const noteId of noteIds) {
    done += 1;
    try {
      const infos = await api.noteVersions(noteId);
      const batch: ImportNoteVersion[] = [];
      for (const info of infos) {
        const v = await api.noteVersion(noteId, info.id);
        const payload = await decryptNotePayload(mk, v as unknown as NoteRecord);
        batch.push({
          note_id: noteId,
          kind: 'legacy',
          name: null,
          created: v.createdAt,
          snapshot: Array.from(
            new TextEncoder().encode(JSON.stringify({ title: payload.title, body: payload.body })),
          ),
        });
      }
      imported += await importNoteVersions(batch);
    } catch {
      // Best-effort per D10 — a note with unreadable versions still migrated.
    }
    onProgress({ stage: 'versions', done, total: noteIds.length });
  }
  return imported;
}

async function migrateAttachments(
  pending: PendingBlob[],
  onProgress: (p: MigrationProgress) => void,
): Promise<number> {
  let imported = 0;
  let done = 0;
  for (const { ref, ownerKind, ownerId } of pending) {
    done += 1;
    try {
      if (await attachmentHas(ref.id)) continue;
      const bytes = await api.attachmentDownload(ref.id);
      await attachmentPut(
        {
          id: ref.id,
          owner_kind: ownerKind,
          owner_id: ownerId,
          file_key: Array.from(ub64(ref.key)),
          iv: Array.from(ub64(ref.iv)),
          thumb: null,
          size: ref.size || bytes.length,
          mime: ref.type || null,
          content_hash: null,
        },
        Array.from(bytes),
      );
      imported += 1;
    } catch {
      // A missing/expired server blob is not fatal to the migration; the
      // message keeps its ref and the attachment shows as unavailable.
    }
    onProgress({ stage: 'attachments', done, total: pending.length });
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
  pending: PendingBlob[],
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
        const payload = await decryptMessage(key, msg.ciphertext, msg.iv);
        batch.push(toImportMessage(msg, payload));
        pending.push(
          ...collectBlobRefs(payload.attachments, 'message', `legacy:${conv.id}:${msg.seq}`),
        );
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
  const summary: MigrationSummary = {
    notes: 0,
    sharedNotes: 0,
    noteVersions: 0,
    orgSettings: false,
    profile: false,
    contacts: 0,
    conversations: 0,
    messages: 0,
    attachments: 0,
  };
  const pending: PendingBlob[] = [];

  const notesResult = await migrateNotes(mk, pending, onProgress);
  summary.notes = notesResult.imported;
  summary.sharedNotes = await migrateSharedNotes(keyPair, pending, onProgress);
  summary.noteVersions = await migrateNoteVersions(mk, notesResult.ids, onProgress);
  summary.orgSettings = await migrateOrgSettings(mk);
  summary.profile = await migrateOwnProfile(mk);
  onProgress({ stage: 'settings', done: 1, total: 1 });
  summary.contacts = await migrateContacts(onProgress);

  const conversations = await api.conversations();
  summary.conversations = await importConversations(
    conversations.map((c) => ({ id: c.id, type: c.kind === 'dm' ? 'dm' : 'group' })),
  );
  onProgress({ stage: 'conversations', done: conversations.length, total: conversations.length });

  for (const conv of conversations) {
    summary.messages += await migrateConversation(conv, keyPair, pending, onProgress);
  }

  summary.attachments = await migrateAttachments(pending, onProgress);

  onProgress({ stage: 'done', done: 1, total: 1 });
  return summary;
}
