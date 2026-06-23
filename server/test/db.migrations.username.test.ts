import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';

// The username drop rebuilds the users table without the (login-only,
// server-readable) username column — the handle is now the sole identifier. The
// rebuild must preserve every user row + child references, then never run again.
describe('username-drop migration', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'notes-mig-user-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('drops the username column, preserves users + child rows, assigns handles', () => {
    // Stand up a pre-migration schema: users WITH the NOT NULL UNIQUE username,
    // plus a session referencing a user (to prove the FK survives the rebuild).
    const old = new Database(join(dir, 'notes.db'));
    old.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        role TEXT NOT NULL,
        public_key TEXT,
        wrapped_private_key TEXT,
        recovery_wrapped_mk TEXT,
        recovery_auth_hash TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        recovery INTEGER NOT NULL DEFAULT 0
      );
    `);
    old.prepare('INSERT INTO users (id, username, role, created_at) VALUES (?,?,?,?)').run('u1', 'alice', 'admin', 1);
    old.prepare('INSERT INTO users (id, username, role, created_at) VALUES (?,?,?,?)').run('u2', 'bob', 'member', 2);
    old.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?,?,?,?)').run('s1', 'u1', 1, 9_999_999_999_999);
    old.close();

    const db = openDb(dir);

    // The column is gone.
    const cols = (db.raw.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain('username');

    // Every user survived, with a backfilled handle and its role intact.
    const u1 = db.getUser('u1')!;
    expect(u1.role).toBe('admin');
    expect(u1.handle).toBeTruthy();
    expect(db.getUser('u2')!.role).toBe('member');

    // The child session still references the (rebuilt) user.
    const sess = db.raw.prepare('SELECT user_id FROM sessions WHERE id = ?').get('s1') as { user_id: string };
    expect(sess.user_id).toBe('u1');

    // Idempotent: reopening doesn't rebuild again or throw.
    db.raw.close();
    const db2 = openDb(dir);
    expect((db2.raw.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name)).not.toContain('username');
    expect(db2.getUser('u1')!.handle).toBe(u1.handle);
    db2.raw.close();
  });
});
