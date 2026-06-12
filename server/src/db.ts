import Database, { type Database as SqliteDatabase } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Role, WrappedKey, UserInfo, CredentialInfo, InviteInfo, NoteRecord } from '@notes/shared';
import { now } from './util.js';

export interface UserRow {
  id: string;
  username: string;
  role: Role;
  public_key: string | null;
  wrapped_private_key: string | null;
  recovery_wrapped_mk: string | null;
  recovery_auth_hash: string | null;
  created_at: number;
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
`;

export type DB = ReturnType<typeof openDb>;

export function openDb(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'notes.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

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
    createUser(u: { id: string; username: string; role: Role }): void {
      db.prepare('INSERT INTO users (id, username, role, created_at) VALUES (?, ?, ?, ?)').run(
        u.id, u.username, u.role, now(),
      );
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
          `SELECT s.*, u.username AS recipient_username FROM note_shares s
           JOIN users u ON u.id = s.recipient_id WHERE s.note_id = ?`,
        )
        .all(noteId) as {
        note_id: string;
        recipient_id: string;
        recipient_username: string;
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
          `SELECT n.id, n.ciphertext, n.iv, n.created_at, n.updated_at, s.sealed_key, s.access, u.username AS owner_username
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
        owner_username: string;
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
    cleanup(): void {
      db.prepare('DELETE FROM challenges WHERE expires_at < ?').run(now());
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
    },
  };
}

export function toUserInfo(u: UserRow): UserInfo {
  return { id: u.id, username: u.username, role: u.role, createdAt: u.created_at, publicKey: u.public_key };
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
