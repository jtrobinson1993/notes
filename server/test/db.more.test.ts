import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toNoteRecord } from '../src/db.js';
import { makeDb, seedUser, type TestDb } from '../../test/helpers/server.js';

const WK = { salt: 's', iv: 'i', ct: 'c' };

let t: TestDb;
beforeEach(() => {
  t = makeDb();
});
afterEach(() => t.cleanup());

describe('notes', () => {
  it('upsert → get → delete lifecycle, and listNotes filtering', async () => {
    const u = seedUser(t.db);
    t.db.upsertNote({ id: 'n1', userId: u, ciphertext: 'ct', iv: 'iv', wrappedKey: WK, createdAt: 100 });
    const row = t.db.getNote('n1')!;
    expect(row.user_id).toBe(u);
    expect(toNoteRecord(row)).toMatchObject({ id: 'n1', deleted: false, wrappedKey: WK });

    // Default listNotes excludes deleted; since>0 returns by updated_at.
    expect(t.db.listNotes(u, 0).map((n) => n.id)).toEqual(['n1']);
    const ts = t.db.deleteNote('n1');
    expect(t.db.getNote('n1')!.deleted).toBe(1);
    expect(t.db.listNotes(u, 0)).toEqual([]); // deleted hidden from full sync
    expect(t.db.listNotes(u, ts - 1).map((n) => n.id)).toEqual(['n1']); // but visible to delta sync
    expect(toNoteRecord(t.db.getNote('n1')!).wrappedKey).toEqual({ salt: '', iv: '', ct: '' });
  });

  it('an upsert by a different user does not overwrite (scoped to owner)', () => {
    const owner = seedUser(t.db);
    const other = seedUser(t.db);
    t.db.upsertNote({ id: 'n1', userId: owner, ciphertext: 'orig', iv: 'iv', wrappedKey: WK, createdAt: 1 });
    t.db.upsertNote({ id: 'n1', userId: other, ciphertext: 'hax', iv: 'iv', wrappedKey: WK, createdAt: 1 });
    expect(t.db.getNote('n1')!.ciphertext).toBe('orig');
  });

  it('snapshotVersion coalesces rapid edits and lists versions', () => {
    const u = seedUser(t.db);
    t.db.upsertNote({ id: 'n1', userId: u, ciphertext: 'v1', iv: 'iv', wrappedKey: WK, createdAt: 1 });
    const n = t.db.getNote('n1')!;
    t.db.snapshotVersion(n); // first snapshot inserts
    t.db.snapshotVersion(n); // within the 10-min window → coalesced (no new row)
    const versions = t.db.listVersions('n1');
    expect(versions).toHaveLength(1);
    expect(t.db.getVersion('n1', versions[0]!.id)!.ciphertext).toBe('v1');
    expect(t.db.getVersion('n1', 99999)).toBeUndefined();
  });
});

describe('shares', () => {
  it('upsert / get / list / delete and listSharedWith join', () => {
    const owner = seedUser(t.db, { username: 'owner', displayName: 'Owner' });
    const recipient = seedUser(t.db, { id: 'rcp', username: 'rcp', displayName: 'Rcp' });
    t.db.upsertNote({ id: 'n1', userId: owner, ciphertext: 'ct', iv: 'iv', wrappedKey: WK, createdAt: 1 });
    t.db.upsertShare({ noteId: 'n1', recipientId: recipient, sealedKey: 'sk', access: 'read' });

    expect(t.db.getShare('n1', recipient)).toMatchObject({ access: 'read', sealed_key: 'sk' });
    expect(t.db.listShares('n1')[0]).toMatchObject({ recipient_display_name: 'Rcp', access: 'read' });
    expect(t.db.listSharedWith(recipient)[0]).toMatchObject({ id: 'n1', owner_display_name: 'Owner', access: 'read' });

    // Upsert again updates access in place.
    t.db.upsertShare({ noteId: 'n1', recipientId: recipient, sealedKey: 'sk2', access: 'write' });
    expect(t.db.getShare('n1', recipient)!.access).toBe('write');

    t.db.deleteShare('n1', recipient);
    expect(t.db.getShare('n1', recipient)).toBeUndefined();
    expect(t.db.listSharedWith(recipient)).toEqual([]);
  });
});

describe('attachments', () => {
  it('create / get / delete', () => {
    const u = seedUser(t.db);
    t.db.createAttachment({ id: 'a1', userId: u, size: 1234 });
    expect(t.db.getAttachment('a1')).toMatchObject({ user_id: u, size: 1234 });
    t.db.deleteAttachment('a1');
    expect(t.db.getAttachment('a1')).toBeUndefined();
  });
});

describe('user settings', () => {
  it('get is undefined until put, then returns the stored data', () => {
    const u = seedUser(t.db);
    expect(t.db.getUserSetting(u, 'tag-colors')).toBeUndefined();
    t.db.putUserSetting(u, 'tag-colors', '{"x":"#fff"}');
    expect(t.db.getUserSetting(u, 'tag-colors')!.data).toBe('{"x":"#fff"}');
    // Upsert overwrites.
    t.db.putUserSetting(u, 'tag-colors', '{"y":"#000"}');
    expect(t.db.getUserSetting(u, 'tag-colors')!.data).toBe('{"y":"#000"}');
  });
});

describe('challenges', () => {
  it('put → take is one-shot and type-scoped', () => {
    t.db.putChallenge({ id: 'ch1', type: 'login', data: { challenge: 'abc' } });
    expect(t.db.takeChallenge('ch1', 'register')).toBeUndefined(); // wrong type
    expect(t.db.takeChallenge<{ challenge: string }>('ch1', 'login')).toEqual({ challenge: 'abc' });
    expect(t.db.takeChallenge('ch1', 'login')).toBeUndefined(); // consumed
  });
});
