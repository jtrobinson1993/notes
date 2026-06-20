import Database, { type Database as SqliteDatabase } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Role, WrappedKey, UserInfo, CredentialInfo, InviteInfo, NoteRecord } from '@notes/shared';
import { now } from './util.js';
import { generateUniqueHandles } from './handles.js';

export interface UserRow {
  id: string;
  username: string;
  role: Role;
  public_key: string | null;
  wrapped_private_key: string | null;
  recovery_wrapped_mk: string | null;
  recovery_auth_hash: string | null;
  /** Public "Word#1234" handle, shown to non-contacts (the only name the server reads). */
  handle: string | null;
  display_name: string | null;
  name_color: string | null;
  /** 1 = only friends may receive the encrypted profile (default). */
  profile_friends_only: number;
  /** 1 = link previews enabled for this user (default 0 / off). */
  link_previews: number;
  created_at: number;
}

export interface ProfileRow {
  owner_id: string;
  ciphertext: string;
  iv: string;
  epoch: number;
  owner_wrapped_key: string;
  updated_at: number;
}

export interface FriendInviteRow {
  id: string;
  token: string;
  created_by: string;
  created_at: number;
  expires_at: number;
}

export interface FriendRequestRow {
  id: string;
  from_user: string;
  to_user: string;
  created_at: number;
}

export interface FriendRow {
  user_id: string;
  friend_id: string;
  created_at: number;
}

export interface ConversationRow {
  id: string;
  kind: string;
  created_by: string;
  created_at: number;
  dm_key: string | null;
  parent_id: string | null;
  parent_seq: number | null;
  /** group membership policy: 'owner' | 'admins' | 'open' */
  manage_policy: string;
  /** group only: custom plaintext name, or null (member-derived title) */
  name: string | null;
  /** group only: E2EE icon encrypted under the conversation key, or null */
  icon_ct: string | null;
  icon_iv: string | null;
  icon_epoch: number | null;
}

export interface ConversationMemberRow {
  conversation_id: string;
  user_id: string;
  sealed_key: string;
  epoch: number;
  last_read_seq: number;
  joined_at: number;
  role: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  channel_id: string;
  sender_id: string;
  seq: number;
  epoch: number;
  ciphertext: string;
  iv: string;
  created_at: number;
  edited_at: number | null;
}

export interface ReactionRow {
  id: string;
  conversation_id: string;
  channel_id: string;
  seq: number;
  user_id: string;
  ciphertext: string;
  iv: string;
  created_at: number;
}

export interface ChannelRow {
  id: string;
  conversation_id: string;
  name: string;
  type: string;
  position: number;
  created_at: number;
  private: number;
}

export interface DeviceLinkRow {
  id: string;
  code: string;
  secret_hash: string;
  device_public_key: string;
  user_id: string | null;
  sealed_mk: string | null;
  created_at: number;
  expires_at: number;
  completed: number;
}

export interface CredentialRow {
  id: string;
  user_id: string;
  public_key: Buffer;
  counter: number;
  transports: string | null;
  name: string;
  wrapped_mk: string | null;
  created_at: number;
  last_used_at: number | null;
}

export interface SessionRow {
  id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  recovery: number;
}

export interface InviteRow {
  id: string;
  token: string;
  created_by: string;
  created_at: number;
  expires_at: number;
  used_by: string | null;
}

export interface NoteRow {
  id: string;
  user_id: string;
  ciphertext: string;
  iv: string;
  wrapped_key: string;
  created_at: number;
  updated_at: number;
  deleted: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL,
  public_key TEXT,
  wrapped_private_key TEXT,
  recovery_wrapped_mk TEXT,
  recovery_auth_hash TEXT,
  handle TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT,
  name TEXT NOT NULL,
  wrapped_mk TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  recovery INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_by TEXT
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notes_user_updated ON notes(user_id, updated_at);
CREATE TABLE IF NOT EXISTS note_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_note ON note_versions(note_id, created_at);
CREATE TABLE IF NOT EXISTS note_shares (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sealed_key TEXT NOT NULL,
  access TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, recipient_id)
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS friend_invites (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS friend_requests (
  id TEXT PRIMARY KEY,
  from_user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE(from_user, to_user)
);
CREATE TABLE IF NOT EXISTS friends (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  dm_key TEXT UNIQUE,
  parent_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  parent_seq INTEGER
);
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sealed_key TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 0,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (conversation_id, user_id)
);
-- Per-(member, epoch) sealed conversation keys. conversation_members holds only
-- the CURRENT epoch's sealed key; this keeps every earlier epoch a member is
-- entitled to, so a re-keyed group's back-scroll survives a reload (the in-memory
-- key cache is lost). A member's rows are deleted when they leave/are removed,
-- which is what cryptographically revokes their future access.
CREATE TABLE IF NOT EXISTS conversation_keys (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL,
  sealed_key TEXT NOT NULL,
  PRIMARY KEY (conversation_id, user_id, epoch)
);
-- Channels inside a conversation (v4). Only EXTRA channels live here; the
-- "general" channel is virtual (its id equals the conversation id). All channels
-- of a conversation share its key/epochs; a channel only partitions messages +
-- read state. Voice channels are structural until v6.
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  private INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_channels_conv ON channels(conversation_id, position);
-- v5: a PRIVATE channel has its own key + explicit membership (mirrors
-- conversation_members / conversation_keys but scoped to the channel). Open
-- channels have no rows here and use the conversation key. channel_members holds
-- the current-epoch sealed key; channel_keys keeps every epoch for back-scroll.
CREATE TABLE IF NOT EXISTS channel_members (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sealed_key TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);
CREATE TABLE IF NOT EXISTS channel_keys (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL,
  sealed_key TEXT NOT NULL,
  PRIMARY KEY (channel_id, user_id, epoch)
);
-- Per-(channel, member) read cursor for EXTRA channels (v4). The general
-- channel's cursor stays on conversation_members.last_read_seq, so existing
-- DM/thread read tracking is untouched.
CREATE TABLE IF NOT EXISTS channel_reads (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  UNIQUE(conversation_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_messages_conv_seq ON messages(conversation_id, seq);
CREATE TABLE IF NOT EXISTS message_reactions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reactions_conv_seq ON message_reactions(conversation_id, seq);
CREATE TABLE IF NOT EXISTS device_links (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL,
  device_public_key TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  sealed_mk TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0
);
-- A user's E2EE profile blob (bio + avatar), encrypted under their profile key.
-- The server only ever stores the ciphertext, the rotation epoch, and the
-- profile key wrapped under the owner's master key (for cross-device recovery).
CREATE TABLE IF NOT EXISTS profiles (
  owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 0,
  owner_wrapped_key TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- The profile key sealed to each recipient who may render the profile. Deleting
-- a row revokes access to the current blob; rotating (new epoch) revokes future.
CREATE TABLE IF NOT EXISTS profile_keys (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL,
  sealed_key TEXT NOT NULL,
  PRIMARY KEY (owner_id, recipient_id)
);
-- Browser Web Push subscriptions, one per (user, device/endpoint). Used to send
-- content-free "new message" pings when a recipient has no live socket. Carries
-- no plaintext — the server can't read messages.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, endpoint)
);
`;

export type DB = ReturnType<typeof openDb>;

export function openDb(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'notes.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  // Idempotent migration: add users.display_name / name_color if missing.
  const userCols = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
  if (!userCols.some((c) => c.name === 'display_name')) {
    db.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
  }
  if (!userCols.some((c) => c.name === 'name_color')) {
    db.exec('ALTER TABLE users ADD COLUMN name_color TEXT');
  }
  // Profile visibility: 1 = only friends may receive the encrypted profile.
  if (!userCols.some((c) => c.name === 'profile_friends_only')) {
    db.exec('ALTER TABLE users ADD COLUMN profile_friends_only INTEGER NOT NULL DEFAULT 1');
  }
  // Link previews: opt-in, default off.
  if (!userCols.some((c) => c.name === 'link_previews')) {
    db.exec('ALTER TABLE users ADD COLUMN link_previews INTEGER NOT NULL DEFAULT 0');
  }
  // Public "Word#1234" handle. Add the column, enforce uniqueness, then backfill
  // every existing account with a distinct handle so the field is never null.
  if (!userCols.some((c) => c.name === 'handle')) {
    db.exec('ALTER TABLE users ADD COLUMN handle TEXT');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle ON users(handle COLLATE NOCASE)');
  {
    const handleTaken = (h: string) =>
      db.prepare('SELECT 1 FROM users WHERE handle = ? COLLATE NOCASE').get(h) !== undefined;
    const setHandle = db.prepare('UPDATE users SET handle = ? WHERE id = ?');
    const missing = db.prepare('SELECT id FROM users WHERE handle IS NULL').all() as { id: string }[];
    for (const u of missing) {
      const [h] = generateUniqueHandles(1, handleTaken);
      if (h) setHandle.run(h, u.id);
    }
  }

  // Idempotent migration: add messages.edited_at (message editing).
  const msgCols = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
  if (!msgCols.some((c) => c.name === 'edited_at')) {
    db.exec('ALTER TABLE messages ADD COLUMN edited_at INTEGER');
  }
  // Idempotent migration (v4): channels. Tag every existing message/reaction with
  // its conversation's general channel (channel_id = conversation_id), so all
  // prior history lands in the general channel and existing DMs/threads/groups
  // keep working with zero behavior change.
  if (!msgCols.some((c) => c.name === 'channel_id')) {
    db.exec("ALTER TABLE messages ADD COLUMN channel_id TEXT NOT NULL DEFAULT ''");
    db.exec('UPDATE messages SET channel_id = conversation_id');
    db.exec('CREATE INDEX IF NOT EXISTS idx_messages_channel_seq ON messages(channel_id, seq)');
  }
  const reactionCols = db.prepare('PRAGMA table_info(message_reactions)').all() as { name: string }[];
  if (!reactionCols.some((c) => c.name === 'channel_id')) {
    db.exec("ALTER TABLE message_reactions ADD COLUMN channel_id TEXT NOT NULL DEFAULT ''");
    db.exec('UPDATE message_reactions SET channel_id = conversation_id');
  }
  // The per-channel indexes are created here (not in SCHEMA) so they exist on
  // both fresh DBs and DBs whose channel_id column was just added above.
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_channel_seq ON messages(channel_id, seq)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_reactions_channel_seq ON message_reactions(channel_id, seq)');
  // v5: channels.private. Existing channels stay open (private=0) — all members
  // keep access, matching v4 behaviour.
  const channelCols = db.prepare('PRAGMA table_info(channels)').all() as { name: string }[];
  if (channelCols.length && !channelCols.some((c) => c.name === 'private')) {
    db.exec('ALTER TABLE channels ADD COLUMN private INTEGER NOT NULL DEFAULT 0');
  }

  // Idempotent migration: add conversations.parent_id/parent_seq (threads).
  // Must precede the partial unique index, which references parent_id.
  const convCols = db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[];
  if (!convCols.some((c) => c.name === 'parent_id')) {
    db.exec('ALTER TABLE conversations ADD COLUMN parent_id TEXT REFERENCES conversations(id) ON DELETE CASCADE');
  }
  if (!convCols.some((c) => c.name === 'parent_seq')) {
    db.exec('ALTER TABLE conversations ADD COLUMN parent_seq INTEGER');
  }
  // Group membership policy (v3 phase 2). Default to owner-only.
  if (!convCols.some((c) => c.name === 'manage_policy')) {
    db.exec("ALTER TABLE conversations ADD COLUMN manage_policy TEXT NOT NULL DEFAULT 'owner'");
    // The creator of an existing group becomes its owner (others stay members).
    db.exec(
      `UPDATE conversation_members SET role = 'owner'
         WHERE user_id = (SELECT created_by FROM conversations c WHERE c.id = conversation_id)
           AND (SELECT kind FROM conversations c WHERE c.id = conversation_id) = 'group'`,
    );
  }
  // Group name + E2EE icon (v6 polish): custom name (plaintext metadata) + an
  // icon encrypted under the conversation key.
  if (!convCols.some((c) => c.name === 'name')) db.exec('ALTER TABLE conversations ADD COLUMN name TEXT');
  if (!convCols.some((c) => c.name === 'icon_ct')) {
    db.exec('ALTER TABLE conversations ADD COLUMN icon_ct TEXT');
    db.exec('ALTER TABLE conversations ADD COLUMN icon_iv TEXT');
    db.exec('ALTER TABLE conversations ADD COLUMN icon_epoch INTEGER');
  }
  // Backfill per-epoch keys from the current sealed_key for any conversation that
  // predates the conversation_keys table, so existing back-scroll stays readable.
  const hasKeyRows = db.prepare('SELECT 1 FROM conversation_keys LIMIT 1').get();
  if (!hasKeyRows) {
    db.exec(
      `INSERT OR IGNORE INTO conversation_keys (conversation_id, user_id, epoch, sealed_key)
         SELECT conversation_id, user_id, epoch, sealed_key FROM conversation_members`,
    );
  }
  // One thread per (parent conversation, parent message). Partial index so NULL
  // parent_id (DMs/groups) is unconstrained.
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_parent ON conversations(parent_id, parent_seq) WHERE parent_id IS NOT NULL',
  );

  return {
    raw: db as SqliteDatabase,

    userCount(): number {
      return (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
    },
    getUser(id: string): UserRow | undefined {
      return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    },
    getUserByUsername(username: string): UserRow | undefined {
      return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username) as UserRow | undefined;
    },
    getUserByHandle(handle: string): UserRow | undefined {
      return db.prepare('SELECT * FROM users WHERE handle = ? COLLATE NOCASE').get(handle) as UserRow | undefined;
    },
    handleTaken(handle: string): boolean {
      return db.prepare('SELECT 1 FROM users WHERE handle = ? COLLATE NOCASE').get(handle) !== undefined;
    },
    /** `count` distinct, currently-free handles to offer the user. */
    generateHandleOptions(count: number): string[] {
      const taken = (h: string) => db.prepare('SELECT 1 FROM users WHERE handle = ? COLLATE NOCASE').get(h) !== undefined;
      return generateUniqueHandles(count, taken);
    },
    /** Set a user's handle; returns false if it's already taken (unique index). */
    setUserHandle(userId: string, handle: string): boolean {
      try {
        return db.prepare('UPDATE users SET handle = ? WHERE id = ?').run(handle, userId).changes > 0;
      } catch {
        return false;
      }
    },
    createUser(u: { id: string; username: string; role: Role }): string {
      const taken = (h: string) => db.prepare('SELECT 1 FROM users WHERE handle = ? COLLATE NOCASE').get(h) !== undefined;
      const [handle] = generateUniqueHandles(1, taken);
      db.prepare('INSERT INTO users (id, username, role, handle, created_at) VALUES (?, ?, ?, ?, ?)').run(
        u.id, u.username, u.role, handle ?? null, now(),
      );
      return handle ?? '';
    },
    setUserKeys(userId: string, keys: { publicKey: string; wrappedPrivateKey: WrappedKey; recoveryWrappedMk: WrappedKey; recoveryAuthHash: string }): void {
      db.prepare(
        'UPDATE users SET public_key = ?, wrapped_private_key = ?, recovery_wrapped_mk = ?, recovery_auth_hash = ? WHERE id = ?',
      ).run(keys.publicKey, JSON.stringify(keys.wrappedPrivateKey), JSON.stringify(keys.recoveryWrappedMk), keys.recoveryAuthHash, userId);
    },
    listUsers(): UserRow[] {
      return db.prepare('SELECT * FROM users ORDER BY created_at').all() as UserRow[];
    },
    deleteUser(id: string): void {
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    },

    createCredential(c: { id: string; userId: string; publicKey: Buffer; counter: number; transports: string[] | undefined; name: string }): void {
      db.prepare(
        'INSERT INTO credentials (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(c.id, c.userId, c.publicKey, c.counter, c.transports ? JSON.stringify(c.transports) : null, c.name, now());
    },
    getCredential(id: string): CredentialRow | undefined {
      return db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as CredentialRow | undefined;
    },
    listCredentials(userId: string): CredentialRow[] {
      return db.prepare('SELECT * FROM credentials WHERE user_id = ? ORDER BY created_at').all(userId) as CredentialRow[];
    },
    updateCredentialCounter(id: string, counter: number): void {
      db.prepare('UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?').run(counter, now(), id);
    },
    setCredentialWrappedMk(id: string, wrapped: WrappedKey): void {
      db.prepare('UPDATE credentials SET wrapped_mk = ? WHERE id = ?').run(JSON.stringify(wrapped), id);
    },
    renameCredential(id: string, name: string): void {
      db.prepare('UPDATE credentials SET name = ? WHERE id = ?').run(name, id);
    },
    deleteCredential(id: string): void {
      db.prepare('DELETE FROM credentials WHERE id = ?').run(id);
    },

    createSession(s: { id: string; userId: string; expiresAt: number; recovery: boolean }): void {
      db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, recovery) VALUES (?, ?, ?, ?, ?)').run(
        s.id, s.userId, now(), s.expiresAt, s.recovery ? 1 : 0,
      );
    },
    getSession(id: string): SessionRow | undefined {
      const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
      if (row && row.expires_at < now()) {
        db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
        return undefined;
      }
      return row;
    },
    deleteSession(id: string): void {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    },

    createInvite(i: { id: string; token: string; createdBy: string; expiresAt: number }): void {
      db.prepare('INSERT INTO invites (id, token, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
        i.id, i.token, i.createdBy, now(), i.expiresAt,
      );
    },
    getInviteByToken(token: string): InviteRow | undefined {
      return db.prepare('SELECT * FROM invites WHERE token = ?').get(token) as InviteRow | undefined;
    },
    listInvites(): InviteRow[] {
      return db.prepare('SELECT * FROM invites ORDER BY created_at DESC').all() as InviteRow[];
    },
    markInviteUsed(id: string, userId: string): void {
      db.prepare('UPDATE invites SET used_by = ? WHERE id = ?').run(userId, id);
    },
    deleteInvite(id: string): void {
      db.prepare('DELETE FROM invites WHERE id = ?').run(id);
    },

    upsertNote(n: { id: string; userId: string; ciphertext: string; iv: string; wrappedKey: WrappedKey; createdAt: number }): number {
      const ts = now();
      db.prepare(
        `INSERT INTO notes (id, user_id, ciphertext, iv, wrapped_key, created_at, updated_at, deleted)
         VALUES (@id, @userId, @ciphertext, @iv, @wrappedKey, @createdAt, @ts, 0)
         ON CONFLICT(id) DO UPDATE SET
           ciphertext = @ciphertext, iv = @iv, wrapped_key = @wrappedKey, updated_at = @ts, deleted = 0
           WHERE notes.user_id = @userId`,
      ).run({ ...n, wrappedKey: JSON.stringify(n.wrappedKey), ts });
      return ts;
    },
    getNote(id: string): NoteRow | undefined {
      return db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined;
    },
    deleteNote(id: string): number {
      const ts = now();
      db.prepare("UPDATE notes SET ciphertext = '', iv = '', wrapped_key = '', deleted = 1, updated_at = ? WHERE id = ?").run(ts, id);
      return ts;
    },
    listNotes(userId: string, since: number): NoteRow[] {
      if (since > 0) {
        return db.prepare('SELECT * FROM notes WHERE user_id = ? AND updated_at > ?').all(userId, since) as NoteRow[];
      }
      return db.prepare('SELECT * FROM notes WHERE user_id = ? AND deleted = 0').all(userId) as NoteRow[];
    },

    /** Snapshot the previous content of a note before an update. Coalesces
     * rapid autosaves into one version per 10-minute window; keeps last 50. */
    snapshotVersion(n: NoteRow): void {
      const last = db
        .prepare('SELECT created_at FROM note_versions WHERE note_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(n.id) as { created_at: number } | undefined;
      if (last && n.updated_at - last.created_at < 10 * 60_000) return;
      db.prepare(
        'INSERT INTO note_versions (note_id, ciphertext, iv, wrapped_key, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(n.id, n.ciphertext, n.iv, n.wrapped_key, n.updated_at);
      db.prepare(
        `DELETE FROM note_versions WHERE note_id = ? AND id NOT IN (
           SELECT id FROM note_versions WHERE note_id = ? ORDER BY created_at DESC LIMIT 50)`,
      ).run(n.id, n.id);
    },
    listVersions(noteId: string): { id: number; created_at: number }[] {
      return db
        .prepare('SELECT id, created_at FROM note_versions WHERE note_id = ? ORDER BY created_at DESC')
        .all(noteId) as { id: number; created_at: number }[];
    },
    getVersion(noteId: string, versionId: number) {
      return db
        .prepare('SELECT * FROM note_versions WHERE note_id = ? AND id = ?')
        .get(noteId, versionId) as
        | { id: number; note_id: string; ciphertext: string; iv: string; wrapped_key: string; created_at: number }
        | undefined;
    },

    upsertShare(s: { noteId: string; recipientId: string; sealedKey: string; access: string }): void {
      db.prepare(
        `INSERT INTO note_shares (note_id, recipient_id, sealed_key, access, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(note_id, recipient_id) DO UPDATE SET sealed_key = excluded.sealed_key, access = excluded.access`,
      ).run(s.noteId, s.recipientId, s.sealedKey, s.access, now());
    },
    getShare(noteId: string, recipientId: string) {
      return db.prepare('SELECT * FROM note_shares WHERE note_id = ? AND recipient_id = ?').get(noteId, recipientId) as
        | { note_id: string; recipient_id: string; sealed_key: string; access: string; created_at: number }
        | undefined;
    },
    listShares(noteId: string) {
      return db
        .prepare(
          `SELECT s.*, u.display_name AS recipient_display_name FROM note_shares s
           JOIN users u ON u.id = s.recipient_id WHERE s.note_id = ?`,
        )
        .all(noteId) as {
        note_id: string;
        recipient_id: string;
        recipient_display_name: string | null;
        sealed_key: string;
        access: string;
        created_at: number;
      }[];
    },
    deleteShare(noteId: string, recipientId: string): void {
      db.prepare('DELETE FROM note_shares WHERE note_id = ? AND recipient_id = ?').run(noteId, recipientId);
    },
    listSharedWith(recipientId: string) {
      return db
        .prepare(
          `SELECT n.id, n.ciphertext, n.iv, n.created_at, n.updated_at, s.sealed_key, s.access,
                  n.user_id AS owner_id, u.display_name AS owner_display_name
           FROM note_shares s
           JOIN notes n ON n.id = s.note_id AND n.deleted = 0
           JOIN users u ON u.id = n.user_id
           WHERE s.recipient_id = ?`,
        )
        .all(recipientId) as {
        id: string;
        ciphertext: string;
        iv: string;
        created_at: number;
        updated_at: number;
        sealed_key: string;
        access: string;
        owner_id: string;
        owner_display_name: string | null;
      }[];
    },

    createAttachment(a: { id: string; userId: string; size: number }): void {
      db.prepare('INSERT INTO attachments (id, user_id, size, created_at) VALUES (?, ?, ?, ?)').run(
        a.id, a.userId, a.size, now(),
      );
    },
    getAttachment(id: string) {
      return db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as
        | { id: string; user_id: string; size: number; created_at: number }
        | undefined;
    },
    deleteAttachment(id: string): void {
      db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
    },

    listMembers(): { id: string; username: string; public_key: string | null }[] {
      return db.prepare('SELECT id, username, public_key FROM users ORDER BY username').all() as {
        id: string;
        username: string;
        public_key: string | null;
      }[];
    },
    /** A user's friends (the only people they can share a note with). */
    listFriendMembers(userId: string): { id: string; display_name: string | null; public_key: string | null }[] {
      return db
        .prepare(
          `SELECT u.id, u.display_name, u.public_key FROM friends f
           JOIN users u ON u.id = f.friend_id WHERE f.user_id = ? ORDER BY u.display_name`,
        )
        .all(userId) as { id: string; display_name: string | null; public_key: string | null }[];
    },
    /** People you may share with (v5): your friends OR anyone you share a
     *  conversation with (friends-of-friends in a common group). Deduped. */
    listShareableMembers(userId: string): { id: string; display_name: string | null; public_key: string | null }[] {
      return db
        .prepare(
          `SELECT u.id, u.display_name, u.public_key FROM users u
             WHERE u.id != ?
               AND ( u.id IN (SELECT friend_id FROM friends WHERE user_id = ?)
                  OR u.id IN (
                       SELECT cm2.user_id FROM conversation_members cm1
                         JOIN conversation_members cm2 ON cm1.conversation_id = cm2.conversation_id
                        WHERE cm1.user_id = ? AND cm2.user_id != ?) )
             ORDER BY u.display_name`,
        )
        .all(userId, userId, userId, userId) as { id: string; display_name: string | null; public_key: string | null }[];
    },

    getUserSetting(userId: string, key: string) {
      return db.prepare('SELECT data, updated_at FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key) as
        | { data: string; updated_at: number }
        | undefined;
    },
    putUserSetting(userId: string, key: string, data: string): number {
      const ts = now();
      db.prepare(
        `INSERT INTO user_settings (user_id, key, data, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      ).run(userId, key, data, ts);
      return ts;
    },

    // ---- Web Push subscriptions ----
    addPushSubscription(s: { userId: string; endpoint: string; p256dh: string; auth: string }): void {
      db.prepare(
        `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
      ).run(s.userId, s.endpoint, s.p256dh, s.auth, now());
    },
    listPushSubscriptions(userId: string): { endpoint: string; p256dh: string; auth: string }[] {
      return db
        .prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?')
        .all(userId) as { endpoint: string; p256dh: string; auth: string }[];
    },
    deletePushSubscription(userId: string, endpoint: string): void {
      db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
    },

    putChallenge(c: { id: string; type: string; data: unknown }): void {
      db.prepare('INSERT INTO challenges (id, type, data, expires_at) VALUES (?, ?, ?, ?)').run(
        c.id, c.type, JSON.stringify(c.data), now() + 5 * 60_000,
      );
    },
    takeChallenge<T>(id: string, type: string): T | undefined {
      const row = db.prepare('SELECT * FROM challenges WHERE id = ? AND type = ?').get(id, type) as
        | { id: string; type: string; data: string; expires_at: number }
        | undefined;
      if (!row) return undefined;
      db.prepare('DELETE FROM challenges WHERE id = ?').run(id);
      if (row.expires_at < now()) return undefined;
      return JSON.parse(row.data) as T;
    },
    setDisplayName(userId: string, displayName: string): void {
      db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, userId);
    },
    setNameColor(userId: string, nameColor: string | null): void {
      db.prepare('UPDATE users SET name_color = ? WHERE id = ?').run(nameColor, userId);
    },

    // ---- Profiles (E2EE bio + avatar) ----
    setProfileVisibility(userId: string, friendsOnly: boolean): void {
      db.prepare('UPDATE users SET profile_friends_only = ? WHERE id = ?').run(friendsOnly ? 1 : 0, userId);
    },
    setLinkPreviews(userId: string, enabled: boolean): void {
      db.prepare('UPDATE users SET link_previews = ? WHERE id = ?').run(enabled ? 1 : 0, userId);
    },
    getProfile(ownerId: string): ProfileRow | undefined {
      return db.prepare('SELECT * FROM profiles WHERE owner_id = ?').get(ownerId) as ProfileRow | undefined;
    },
    upsertProfile(p: { ownerId: string; ciphertext: string; iv: string; epoch: number; ownerWrappedKey: string }): void {
      db.prepare(
        `INSERT INTO profiles (owner_id, ciphertext, iv, epoch, owner_wrapped_key, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_id) DO UPDATE SET
           ciphertext = excluded.ciphertext, iv = excluded.iv, epoch = excluded.epoch,
           owner_wrapped_key = excluded.owner_wrapped_key, updated_at = excluded.updated_at`,
      ).run(p.ownerId, p.ciphertext, p.iv, p.epoch, p.ownerWrappedKey, now());
    },
    /** Replace the full set of sealed keys for an owner (used on set + rotation). */
    replaceProfileKeys(ownerId: string, epoch: number, keys: { recipientId: string; sealedKey: string }[]): void {
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM profile_keys WHERE owner_id = ?').run(ownerId);
        const ins = db.prepare(
          'INSERT INTO profile_keys (owner_id, recipient_id, epoch, sealed_key) VALUES (?, ?, ?, ?)',
        );
        for (const k of keys) ins.run(ownerId, k.recipientId, epoch, k.sealedKey);
      });
      tx();
    },
    /** Add/replace one recipient's sealed key (used to distribute to a new friend). */
    upsertProfileKey(ownerId: string, recipientId: string, epoch: number, sealedKey: string): void {
      db.prepare(
        `INSERT INTO profile_keys (owner_id, recipient_id, epoch, sealed_key) VALUES (?, ?, ?, ?)
         ON CONFLICT(owner_id, recipient_id) DO UPDATE SET epoch = excluded.epoch, sealed_key = excluded.sealed_key`,
      ).run(ownerId, recipientId, epoch, sealedKey);
    },
    getProfileKeyFor(ownerId: string, recipientId: string): { sealed_key: string; epoch: number } | undefined {
      return db
        .prepare('SELECT sealed_key, epoch FROM profile_keys WHERE owner_id = ? AND recipient_id = ?')
        .get(ownerId, recipientId) as { sealed_key: string; epoch: number } | undefined;
    },
    /** Revoke profile-key access in both directions (used on unfriend). */
    deleteProfileKeyPair(a: string, b: string): void {
      db.prepare(
        'DELETE FROM profile_keys WHERE (owner_id = ? AND recipient_id = ?) OR (owner_id = ? AND recipient_id = ?)',
      ).run(a, b, b, a);
    },
    /** Drop any sealed keys an owner granted to non-friends (used when switching
     *  visibility back to friends-only). */
    deleteNonFriendProfileKeys(ownerId: string): void {
      db.prepare(
        `DELETE FROM profile_keys WHERE owner_id = ? AND recipient_id NOT IN
           (SELECT friend_id FROM friends WHERE user_id = ?)`,
      ).run(ownerId, ownerId);
    },
    /** True if the two users share any conversation (DM, group, or thread). */
    sharesConversation(a: string, b: string): boolean {
      return !!db
        .prepare(
          `SELECT 1 FROM conversation_members cm1
             JOIN conversation_members cm2 ON cm1.conversation_id = cm2.conversation_id
            WHERE cm1.user_id = ? AND cm2.user_id = ? LIMIT 1`,
        )
        .get(a, b);
    },

    // ---- Friend invites ----
    createFriendInvite(i: { id: string; token: string; createdBy: string; expiresAt: number }): void {
      db.prepare(
        'INSERT INTO friend_invites (id, token, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      ).run(i.id, i.token, i.createdBy, now(), i.expiresAt);
    },
    getFriendInviteByToken(token: string): FriendInviteRow | undefined {
      const row = db.prepare('SELECT * FROM friend_invites WHERE token = ?').get(token) as FriendInviteRow | undefined;
      if (row && row.expires_at < now()) {
        db.prepare('DELETE FROM friend_invites WHERE id = ?').run(row.id);
        return undefined;
      }
      return row;
    },
    getFriendInvite(id: string): FriendInviteRow | undefined {
      const row = db.prepare('SELECT * FROM friend_invites WHERE id = ?').get(id) as FriendInviteRow | undefined;
      if (row && row.expires_at < now()) {
        db.prepare('DELETE FROM friend_invites WHERE id = ?').run(row.id);
        return undefined;
      }
      return row;
    },
    listFriendInvites(userId: string): FriendInviteRow[] {
      return db
        .prepare('SELECT * FROM friend_invites WHERE created_by = ? AND expires_at >= ? ORDER BY created_at DESC')
        .all(userId, now()) as FriendInviteRow[];
    },
    deleteFriendInvite(id: string): void {
      db.prepare('DELETE FROM friend_invites WHERE id = ?').run(id);
    },
    purgeExpiredInvites(): void {
      db.prepare('DELETE FROM friend_invites WHERE expires_at < ?').run(now());
    },

    // ---- Friend requests ----
    createFriendRequest(r: { id: string; fromUser: string; toUser: string }): void {
      db.prepare('INSERT INTO friend_requests (id, from_user, to_user, created_at) VALUES (?, ?, ?, ?)').run(
        r.id, r.fromUser, r.toUser, now(),
      );
    },
    getFriendRequest(id: string): FriendRequestRow | undefined {
      return db.prepare('SELECT * FROM friend_requests WHERE id = ?').get(id) as FriendRequestRow | undefined;
    },
    /** Any pending request between two users, in either direction. */
    getFriendRequestBetween(a: string, b: string): FriendRequestRow | undefined {
      return db
        .prepare(
          'SELECT * FROM friend_requests WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)',
        )
        .get(a, b, b, a) as FriendRequestRow | undefined;
    },
    listFriendRequests(userId: string): FriendRequestRow[] {
      return db
        .prepare('SELECT * FROM friend_requests WHERE from_user = ? OR to_user = ? ORDER BY created_at DESC')
        .all(userId, userId) as FriendRequestRow[];
    },
    deleteFriendRequest(id: string): void {
      db.prepare('DELETE FROM friend_requests WHERE id = ?').run(id);
    },

    // ---- Friends ----
    areFriends(userId: string, friendId: string): boolean {
      return (
        db.prepare('SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?').get(userId, friendId) !== undefined
      );
    },
    addFriendPair(a: string, b: string): void {
      const ts = now();
      const ins = db.prepare(
        'INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)',
      );
      const tx = db.transaction(() => {
        ins.run(a, b, ts);
        ins.run(b, a, ts);
      });
      tx();
    },
    listFriendIds(userId: string): string[] {
      return (db.prepare('SELECT friend_id FROM friends WHERE user_id = ?').all(userId) as { friend_id: string }[]).map(
        (r) => r.friend_id,
      );
    },
    listFriendRows(userId: string): FriendRow[] {
      return db
        .prepare('SELECT * FROM friends WHERE user_id = ? ORDER BY created_at DESC')
        .all(userId) as FriendRow[];
    },
    deleteFriendPair(a: string, b: string): void {
      db.prepare('DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)').run(
        a, b, b, a,
      );
    },

    // ---- Conversations ----
    createConversation(c: {
      id: string;
      kind: string;
      createdBy: string;
      dmKey: string | null;
      parentId?: string | null;
      parentSeq?: number | null;
    }): void {
      db.prepare(
        'INSERT INTO conversations (id, kind, created_by, created_at, dm_key, parent_id, parent_seq) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(c.id, c.kind, c.createdBy, now(), c.dmKey, c.parentId ?? null, c.parentSeq ?? null);
    },
    getConversation(id: string): ConversationRow | undefined {
      return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined;
    },
    setConversationName(id: string, name: string | null): void {
      db.prepare('UPDATE conversations SET name = ? WHERE id = ?').run(name, id);
    },
    setConversationIcon(id: string, icon: { ct: string; iv: string; epoch: number } | null): void {
      db.prepare('UPDATE conversations SET icon_ct = ?, icon_iv = ?, icon_epoch = ? WHERE id = ?').run(
        icon?.ct ?? null,
        icon?.iv ?? null,
        icon?.epoch ?? null,
        id,
      );
    },
    getConversationByDmKey(dmKey: string): ConversationRow | undefined {
      return db.prepare('SELECT * FROM conversations WHERE dm_key = ?').get(dmKey) as ConversationRow | undefined;
    },
    /** The thread rooted on a specific parent message, if any. */
    getThreadByParent(parentId: string, parentSeq: number): ConversationRow | undefined {
      return db
        .prepare('SELECT * FROM conversations WHERE parent_id = ? AND parent_seq = ?')
        .get(parentId, parentSeq) as ConversationRow | undefined;
    },
    listConversationsForUser(userId: string): ConversationRow[] {
      return db
        .prepare(
          `SELECT c.* FROM conversations c
           JOIN conversation_members m ON m.conversation_id = c.id
           WHERE m.user_id = ?
           ORDER BY c.created_at DESC`,
        )
        .all(userId) as ConversationRow[];
    },

    // ---- Conversation members ----
    addConversationMember(m: {
      conversationId: string;
      userId: string;
      sealedKey: string;
      epoch: number;
      role?: string;
      /** start unread baseline at the join point (e.g. a fresh-history joiner) */
      lastReadSeq?: number;
    }): void {
      db.prepare(
        `INSERT INTO conversation_members (conversation_id, user_id, sealed_key, epoch, last_read_seq, joined_at, role)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(m.conversationId, m.userId, m.sealedKey, m.epoch, m.lastReadSeq ?? 0, now(), m.role ?? 'member');
      // Mirror the current sealed key into the per-epoch store.
      db.prepare(
        `INSERT OR REPLACE INTO conversation_keys (conversation_id, user_id, epoch, sealed_key)
         VALUES (?, ?, ?, ?)`,
      ).run(m.conversationId, m.userId, m.epoch, m.sealedKey);
    },
    /** Remove a member and revoke all their sealed keys (future-access cut). */
    removeConversationMember(conversationId: string, userId: string): void {
      db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(conversationId, userId);
      db.prepare('DELETE FROM conversation_keys WHERE conversation_id = ? AND user_id = ?').run(conversationId, userId);
    },
    /** The conversation's current epoch = the highest epoch any member holds. */
    getConversationEpoch(conversationId: string): number {
      const r = db
        .prepare('SELECT MAX(epoch) AS e FROM conversation_members WHERE conversation_id = ?')
        .get(conversationId) as { e: number | null };
      return r.e ?? 0;
    },
    /** Re-key an existing member to a new epoch: update their current sealed key
     *  and append the new per-epoch row (earlier epochs are retained). */
    setMemberEpochKey(conversationId: string, userId: string, epoch: number, sealedKey: string): void {
      db.prepare(
        'UPDATE conversation_members SET epoch = ?, sealed_key = ? WHERE conversation_id = ? AND user_id = ?',
      ).run(epoch, sealedKey, conversationId, userId);
      db.prepare(
        `INSERT OR REPLACE INTO conversation_keys (conversation_id, user_id, epoch, sealed_key)
         VALUES (?, ?, ?, ?)`,
      ).run(conversationId, userId, epoch, sealedKey);
    },
    /** Seal one prior-epoch key to a member (history shared to a new joiner). */
    addConversationKey(conversationId: string, userId: string, epoch: number, sealedKey: string): void {
      db.prepare(
        `INSERT OR REPLACE INTO conversation_keys (conversation_id, user_id, epoch, sealed_key)
         VALUES (?, ?, ?, ?)`,
      ).run(conversationId, userId, epoch, sealedKey);
    },
    /** Every epoch key a member can read, ascending. */
    listConversationKeysForUser(conversationId: string, userId: string): { epoch: number; sealed_key: string }[] {
      return db
        .prepare(
          'SELECT epoch, sealed_key FROM conversation_keys WHERE conversation_id = ? AND user_id = ? ORDER BY epoch',
        )
        .all(conversationId, userId) as { epoch: number; sealed_key: string }[];
    },
    setConversationMemberRole(conversationId: string, userId: string, role: string): void {
      db.prepare('UPDATE conversation_members SET role = ? WHERE conversation_id = ? AND user_id = ?').run(
        role,
        conversationId,
        userId,
      );
    },
    getConversationMember(conversationId: string, userId: string): ConversationMemberRow | undefined {
      return db
        .prepare('SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
        .get(conversationId, userId) as ConversationMemberRow | undefined;
    },
    listConversationMembers(conversationId: string): ConversationMemberRow[] {
      // `user_id` tiebreaks members that joined in the same transaction (equal
      // joined_at), so ordering — and owner-succession on a leave — is stable.
      return db
        .prepare('SELECT * FROM conversation_members WHERE conversation_id = ? ORDER BY joined_at, user_id')
        .all(conversationId) as ConversationMemberRow[];
    },
    listConversationMemberIds(conversationId: string): string[] {
      return (
        db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?').all(conversationId) as {
          user_id: string;
        }[]
      ).map((r) => r.user_id);
    },
    /** General channel's read cursor lives on the member row; extra channels use
     *  the channel_reads table. (channelId === conversationId ⇒ general.) */
    setLastReadSeq(conversationId: string, channelId: string, userId: string, seq: number): void {
      if (channelId === conversationId) {
        db.prepare(
          'UPDATE conversation_members SET last_read_seq = MAX(last_read_seq, ?) WHERE conversation_id = ? AND user_id = ?',
        ).run(seq, conversationId, userId);
        return;
      }
      const prev = (
        db.prepare('SELECT last_read_seq AS s FROM channel_reads WHERE channel_id = ? AND user_id = ?').get(
          channelId,
          userId,
        ) as { s: number } | undefined
      )?.s ?? 0;
      db.prepare(
        `INSERT OR REPLACE INTO channel_reads (channel_id, user_id, last_read_seq) VALUES (?, ?, ?)`,
      ).run(channelId, userId, Math.max(prev, seq));
    },
    /** A member's last-read seq in one channel (general falls back to the member row). */
    getLastReadSeq(conversationId: string, channelId: string, userId: string): number {
      if (channelId === conversationId) {
        return (
          db.prepare('SELECT last_read_seq AS s FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(
            conversationId,
            userId,
          ) as { s: number } | undefined
        )?.s ?? 0;
      }
      return (
        db.prepare('SELECT last_read_seq AS s FROM channel_reads WHERE channel_id = ? AND user_id = ?').get(
          channelId,
          userId,
        ) as { s: number } | undefined
      )?.s ?? 0;
    },

    // ---- Channels (v4) ----
    createChannel(c: { id: string; conversationId: string; name: string; type: string; position: number; private?: boolean }): ChannelRow {
      const createdAt = now();
      const priv = c.private ? 1 : 0;
      db.prepare(
        'INSERT INTO channels (id, conversation_id, name, type, position, created_at, private) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(c.id, c.conversationId, c.name, c.type, c.position, createdAt, priv);
      return { id: c.id, conversation_id: c.conversationId, name: c.name, type: c.type, position: c.position, created_at: createdAt, private: priv };
    },
    getChannel(id: string): ChannelRow | undefined {
      return db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as ChannelRow | undefined;
    },
    listChannels(conversationId: string): ChannelRow[] {
      return db
        .prepare('SELECT * FROM channels WHERE conversation_id = ? ORDER BY position, created_at')
        .all(conversationId) as ChannelRow[];
    },
    countChannels(conversationId: string): number {
      return (
        db.prepare('SELECT COUNT(*) AS c FROM channels WHERE conversation_id = ?').get(conversationId) as { c: number }
      ).c;
    },
    /** Next position = one past the current max (general occupies 0). */
    nextChannelPosition(conversationId: string): number {
      const r = db
        .prepare('SELECT COALESCE(MAX(position), 0) AS p FROM channels WHERE conversation_id = ?')
        .get(conversationId) as { p: number };
      return r.p + 1;
    },
    renameChannel(id: string, name: string): void {
      db.prepare('UPDATE channels SET name = ? WHERE id = ?').run(name, id);
    },
    /** Apply a new ordering: positions 1..n in the given id order (general is 0). */
    reorderChannels(conversationId: string, orderedIds: string[]): void {
      const stmt = db.prepare('UPDATE channels SET position = ? WHERE id = ? AND conversation_id = ?');
      db.transaction(() => {
        orderedIds.forEach((id, i) => stmt.run(i + 1, id, conversationId));
      })();
    },
    /** Delete a channel and all of its messages/reactions/read cursors + keys. */
    deleteChannel(id: string): void {
      db.transaction(() => {
        db.prepare('DELETE FROM messages WHERE channel_id = ?').run(id);
        db.prepare('DELETE FROM message_reactions WHERE channel_id = ?').run(id);
        db.prepare('DELETE FROM channel_reads WHERE channel_id = ?').run(id);
        db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(id);
        db.prepare('DELETE FROM channel_keys WHERE channel_id = ?').run(id);
        db.prepare('DELETE FROM channels WHERE id = ?').run(id);
      })();
    },

    // ---- Private-channel membership + keys (v5; mirrors conversation_*) ----
    addChannelMember(m: { channelId: string; userId: string; sealedKey: string; epoch: number }): void {
      db.prepare(
        'INSERT INTO channel_members (channel_id, user_id, sealed_key, epoch, joined_at) VALUES (?, ?, ?, ?, ?)',
      ).run(m.channelId, m.userId, m.sealedKey, m.epoch, now());
      db.prepare(
        'INSERT OR REPLACE INTO channel_keys (channel_id, user_id, epoch, sealed_key) VALUES (?, ?, ?, ?)',
      ).run(m.channelId, m.userId, m.epoch, m.sealedKey);
    },
    removeChannelMember(channelId: string, userId: string): void {
      db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?').run(channelId, userId);
      db.prepare('DELETE FROM channel_keys WHERE channel_id = ? AND user_id = ?').run(channelId, userId);
    },
    getChannelMember(channelId: string, userId: string): { sealed_key: string; epoch: number } | undefined {
      return db
        .prepare('SELECT sealed_key, epoch FROM channel_members WHERE channel_id = ? AND user_id = ?')
        .get(channelId, userId) as { sealed_key: string; epoch: number } | undefined;
    },
    isChannelMember(channelId: string, userId: string): boolean {
      return !!db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, userId);
    },
    listChannelMemberIds(channelId: string): string[] {
      return (
        db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(channelId) as { user_id: string }[]
      ).map((r) => r.user_id);
    },
    getChannelEpoch(channelId: string): number {
      const r = db.prepare('SELECT MAX(epoch) AS e FROM channel_members WHERE channel_id = ?').get(channelId) as {
        e: number | null;
      };
      return r.e ?? 0;
    },
    setChannelMemberEpochKey(channelId: string, userId: string, epoch: number, sealedKey: string): void {
      db.prepare('UPDATE channel_members SET epoch = ?, sealed_key = ? WHERE channel_id = ? AND user_id = ?').run(
        epoch, sealedKey, channelId, userId,
      );
      db.prepare(
        'INSERT OR REPLACE INTO channel_keys (channel_id, user_id, epoch, sealed_key) VALUES (?, ?, ?, ?)',
      ).run(channelId, userId, epoch, sealedKey);
    },
    addChannelKey(channelId: string, userId: string, epoch: number, sealedKey: string): void {
      db.prepare(
        'INSERT OR REPLACE INTO channel_keys (channel_id, user_id, epoch, sealed_key) VALUES (?, ?, ?, ?)',
      ).run(channelId, userId, epoch, sealedKey);
    },
    listChannelKeysForUser(channelId: string, userId: string): { epoch: number; sealed_key: string }[] {
      return db
        .prepare('SELECT epoch, sealed_key FROM channel_keys WHERE channel_id = ? AND user_id = ? ORDER BY epoch')
        .all(channelId, userId) as { epoch: number; sealed_key: string }[];
    },

    // ---- Messages ----
    /** Conversation-wide max seq (the shared per-conversation sequence). */
    getMaxSeq(conversationId: string): number {
      return (
        db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE conversation_id = ?').get(conversationId) as {
          s: number;
        }
      ).s;
    },
    /** Max seq within a single channel (0 when empty). */
    getChannelMaxSeq(channelId: string): number {
      return (
        db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE channel_id = ?').get(channelId) as {
          s: number;
        }
      ).s;
    },
    /** Assign the next per-CONVERSATION seq (shared across channels) and insert,
     *  atomically, tagging the message with its channel. */
    insertMessage(m: {
      id: string;
      conversationId: string;
      channelId: string;
      senderId: string;
      epoch: number;
      ciphertext: string;
      iv: string;
    }): MessageRow {
      const tx = db.transaction((): MessageRow => {
        const seq =
          (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM messages WHERE conversation_id = ?').get(
            m.conversationId,
          ) as { s: number }).s;
        const createdAt = now();
        db.prepare(
          `INSERT INTO messages (id, conversation_id, channel_id, sender_id, seq, epoch, ciphertext, iv, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(m.id, m.conversationId, m.channelId, m.senderId, seq, m.epoch, m.ciphertext, m.iv, createdAt);
        return {
          id: m.id,
          conversation_id: m.conversationId,
          channel_id: m.channelId,
          sender_id: m.senderId,
          seq,
          epoch: m.epoch,
          ciphertext: m.ciphertext,
          iv: m.iv,
          created_at: createdAt,
          edited_at: null,
        };
      });
      return tx();
    },
    /** Replace a message's ciphertext/iv and stamp edited_at — only for the
     *  original sender (the `sender_id` guard enforces this at the DB level, so
     *  a forged seq can't edit someone else's message). Returns the updated row,
     *  or null if no such message by this sender. */
    editMessage(m: {
      conversationId: string;
      seq: number;
      senderId: string;
      ciphertext: string;
      iv: string;
    }): MessageRow | null {
      const editedAt = now();
      const res = db
        .prepare(
          `UPDATE messages SET ciphertext = ?, iv = ?, edited_at = ?
             WHERE conversation_id = ? AND seq = ? AND sender_id = ?`,
        )
        .run(m.ciphertext, m.iv, editedAt, m.conversationId, m.seq, m.senderId);
      if (res.changes === 0) return null;
      return db
        .prepare('SELECT * FROM messages WHERE conversation_id = ? AND seq = ?')
        .get(m.conversationId, m.seq) as MessageRow;
    },
    /** A single channel's messages DESC by seq, optionally before an exclusive
     *  seq, for pagination. */
    listMessages(channelId: string, before: number | undefined, limit: number): MessageRow[] {
      if (before !== undefined) {
        return db
          .prepare('SELECT * FROM messages WHERE channel_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
          .all(channelId, before, limit) as MessageRow[];
      }
      return db
        .prepare('SELECT * FROM messages WHERE channel_id = ? ORDER BY seq DESC LIMIT ?')
        .all(channelId, limit) as MessageRow[];
    },

    // ---- Reactions (emoji encrypted with the conversation key) ----
    addReaction(r: {
      id: string;
      conversationId: string;
      channelId: string;
      seq: number;
      userId: string;
      ciphertext: string;
      iv: string;
    }): ReactionRow {
      const createdAt = now();
      db.prepare(
        `INSERT INTO message_reactions (id, conversation_id, channel_id, seq, user_id, ciphertext, iv, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(r.id, r.conversationId, r.channelId, r.seq, r.userId, r.ciphertext, r.iv, createdAt);
      return {
        id: r.id,
        conversation_id: r.conversationId,
        channel_id: r.channelId,
        seq: r.seq,
        user_id: r.userId,
        ciphertext: r.ciphertext,
        iv: r.iv,
        created_at: createdAt,
      };
    },
    getReaction(id: string): ReactionRow | undefined {
      return db.prepare('SELECT * FROM message_reactions WHERE id = ?').get(id) as ReactionRow | undefined;
    },
    /** A single message by its conversation-unique seq (to resolve its channel). */
    getMessageBySeq(conversationId: string, seq: number): MessageRow | undefined {
      return db
        .prepare('SELECT * FROM messages WHERE conversation_id = ? AND seq = ?')
        .get(conversationId, seq) as MessageRow | undefined;
    },
    /** Delete a reaction only if it belongs to `userId`; returns true if removed. */
    removeReaction(id: string, userId: string): boolean {
      return (
        db.prepare('DELETE FROM message_reactions WHERE id = ? AND user_id = ?').run(id, userId).changes > 0
      );
    },
    listReactions(channelId: string, limit = 5000): ReactionRow[] {
      return db
        .prepare('SELECT * FROM message_reactions WHERE channel_id = ? ORDER BY created_at ASC LIMIT ?')
        .all(channelId, limit) as ReactionRow[];
    },

    // ---- Device links (cross-device onboarding) ----
    createDeviceLink(l: {
      id: string;
      code: string;
      secretHash: string;
      devicePublicKey: string;
      expiresAt: number;
    }): void {
      db.prepare(
        'INSERT INTO device_links (id, code, secret_hash, device_public_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(l.id, l.code, l.secretHash, l.devicePublicKey, now(), l.expiresAt);
    },
    getDeviceLinkByCode(code: string): DeviceLinkRow | undefined {
      const row = db.prepare('SELECT * FROM device_links WHERE code = ?').get(code) as DeviceLinkRow | undefined;
      if (row && row.expires_at < now()) {
        db.prepare('DELETE FROM device_links WHERE id = ?').run(row.id);
        return undefined;
      }
      return row;
    },
    /** Seal the link to a user, single-use: succeeds only while still unsealed. */
    sealDeviceLink(id: string, userId: string, sealedMk: string): boolean {
      const res = db
        .prepare('UPDATE device_links SET user_id = ?, sealed_mk = ? WHERE id = ? AND user_id IS NULL AND completed = 0')
        .run(userId, sealedMk, id);
      return res.changes === 1;
    },
    /** Mark the link consumed, single-use: succeeds only once, while sealed. */
    completeDeviceLink(id: string): boolean {
      const res = db
        .prepare('UPDATE device_links SET completed = 1 WHERE id = ? AND user_id IS NOT NULL AND completed = 0')
        .run(id);
      return res.changes === 1;
    },
    deleteDeviceLink(id: string): void {
      db.prepare('DELETE FROM device_links WHERE id = ?').run(id);
    },
    purgeExpiredDeviceLinks(): void {
      db.prepare('DELETE FROM device_links WHERE expires_at < ?').run(now());
    },

    cleanup(): void {
      db.prepare('DELETE FROM challenges WHERE expires_at < ?').run(now());
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
      db.prepare('DELETE FROM friend_invites WHERE expires_at < ?').run(now());
      db.prepare('DELETE FROM device_links WHERE expires_at < ?').run(now());
    },
  };
}

/** The display name shown to OTHER users. Never falls back to the username:
 * usernames are login identifiers and must not be exposed to other users. */
export function effectiveDisplayName(u: { id: string; display_name: string | null }): string {
  return u.display_name && u.display_name.trim() ? u.display_name : `User-${u.id.slice(0, 6)}`;
}

/** The public "Word#1234" handle shown to non-contacts. Falls back to a neutral
 *  id-derived label only if a handle was somehow never assigned. */
export function effectiveHandle(u: { id: string; handle: string | null }): string {
  return u.handle && u.handle.trim() ? u.handle : `User-${u.id.slice(0, 6)}`;
}

export function toUserInfo(u: UserRow): UserInfo {
  return { id: u.id, username: u.username, role: u.role, createdAt: u.created_at, handle: effectiveHandle(u), publicKey: u.public_key };
}

export function toCredentialInfo(c: CredentialRow): CredentialInfo {
  return { id: c.id, name: c.name, createdAt: c.created_at, lastUsedAt: c.last_used_at, hasWrappedMk: c.wrapped_mk !== null };
}

export function toInviteInfo(i: InviteRow): InviteInfo {
  return { id: i.id, token: i.token, createdAt: i.created_at, expiresAt: i.expires_at, usedBy: i.used_by };
}

export function toNoteRecord(n: NoteRow): NoteRecord {
  return {
    id: n.id,
    ciphertext: n.ciphertext,
    iv: n.iv,
    wrappedKey: n.deleted ? { salt: '', iv: '', ct: '' } : (JSON.parse(n.wrapped_key) as WrappedKey),
    createdAt: n.created_at,
    updatedAt: n.updated_at,
    deleted: n.deleted === 1,
  };
}
