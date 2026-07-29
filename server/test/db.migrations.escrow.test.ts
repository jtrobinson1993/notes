import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';

// Relay-held escrow was removed (spec/roadmap.md § "Escrow — removed"): a
// permanently stored, password-wrapped master key is an offline brute-force
// target on a relay whose whole posture is zero-at-rest.
//
// Deleting the table *definition* only stops new rows. A relay upgraded across
// the removal would keep every blob it already had — on disk and in every
// backup, still crackable, and no longer usable by any client. That is exactly
// the liability the removal exists to retire, so boot drops the table.
describe('escrow removal migration', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'notes-escrow-mig-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function tableExists(db: ReturnType<typeof openDb>): boolean {
    const rows = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'relay_escrow'")
      .all();
    return rows.length > 0;
  }

  it('drops a pre-existing relay_escrow table, blobs included', () => {
    // Stand up the pre-removal schema with a stored wrapped key.
    const old = new Database(join(dir, 'notes.db'));
    old.exec(`
      CREATE TABLE relay_escrow (
        user_id TEXT PRIMARY KEY,
        wrapped_mk TEXT NOT NULL,
        kdf_params TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    old
      .prepare('INSERT INTO relay_escrow (user_id, wrapped_mk, kdf_params, updated_at) VALUES (?,?,?,?)')
      .run('u1', 'password-wrapped-master-key', '{"m":19456,"t":2}', 1);
    old.close();

    const db = openDb(dir);
    expect(tableExists(db), 'the table and its blobs must be gone after boot').toBe(false);
    db.raw.close();
  });

  it('is a no-op on a relay that never had escrow, and on a second boot', () => {
    const first = openDb(dir);
    expect(tableExists(first)).toBe(false);
    first.raw.close();

    // Idempotent: opening again must not throw.
    const second = openDb(dir);
    expect(tableExists(second)).toBe(false);
    second.raw.close();
  });

  it('leaves the surviving relay tables alone', () => {
    // Guard against the drop being over-broad — the removal must not take any
    // neighbouring relay state with it.
    const db = openDb(dir);
    for (const table of ['users', 'relay_devices', 'relay_mailbox', 'relay_verifiers']) {
      const rows = db.raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .all(table);
      expect(rows, `${table} must survive`).toHaveLength(1);
    }
    db.raw.close();
  });
});
