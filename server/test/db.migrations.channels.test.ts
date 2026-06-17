import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';

// The v4 channels migration must tag every pre-existing message/reaction with its
// conversation's general channel (channel_id = conversation_id), so all history
// lands in the general channel with zero behaviour change for old DMs/groups.
describe('v4 channels migration', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'notes-mig-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('backfills channel_id = conversation_id on existing messages and reactions', () => {
    // Stand up a pre-v4 schema (messages/message_reactions without channel_id).
    const old = new Database(join(dir, 'notes.db'));
    old.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_id TEXT NOT NULL,
        seq INTEGER NOT NULL, epoch INTEGER NOT NULL, ciphertext TEXT NOT NULL, iv TEXT NOT NULL,
        created_at INTEGER NOT NULL, edited_at INTEGER, UNIQUE(conversation_id, seq)
      );
      CREATE TABLE message_reactions (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, user_id TEXT NOT NULL,
        ciphertext TEXT NOT NULL, iv TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
    old.prepare('INSERT INTO messages (id,conversation_id,sender_id,seq,epoch,ciphertext,iv,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('m1', 'conv-A', 'u1', 1, 0, 'c', 'i', Date.now());
    old.prepare('INSERT INTO message_reactions (id,conversation_id,seq,user_id,ciphertext,iv,created_at) VALUES (?,?,?,?,?,?,?)')
      .run('r1', 'conv-A', 1, 'u1', 'c', 'i', Date.now());
    old.close();

    // Reopening through openDb runs the idempotent migration.
    const db = openDb(dir);
    expect((db.raw.prepare('SELECT channel_id FROM messages WHERE id = ?').get('m1') as { channel_id: string }).channel_id).toBe('conv-A');
    expect((db.raw.prepare('SELECT channel_id FROM message_reactions WHERE id = ?').get('r1') as { channel_id: string }).channel_id).toBe('conv-A');
    // Idempotent: a second open is a no-op and doesn't throw.
    db.raw.close();
    const db2 = openDb(dir);
    expect((db2.raw.prepare('SELECT channel_id FROM messages WHERE id = ?').get('m1') as { channel_id: string }).channel_id).toBe('conv-A');
    db2.raw.close();
  });
});
