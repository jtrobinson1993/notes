//! SQLCipher-encrypted local store (spec/local-store.md).
//!
//! The whole DB — rows, indexes, metadata — is encrypted at rest (roadmap D2).
//! Decrypted content lives in rows so local search can work; the at-rest
//! boundary is the SQLCipher key, never field-level ciphertext.

use rusqlite::Connection;
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("wrong key or corrupt database")]
    BadKey,
}

/// Schema migrations, applied in order; `PRAGMA user_version` = number applied.
/// Forward-only (spec: the core refuses to open a DB newer than itself).
const MIGRATIONS: &[&str] = &[
    // v1 — core tables per spec/local-store.md. FTS5 tables land in a later
    // migration once the sqlcipher bundle's FTS support is confirmed.
    "
    CREATE TABLE relays(
      id TEXT PRIMARY KEY, url TEXT NOT NULL, name TEXT, nickname TEXT,
      identity_fp TEXT NOT NULL, our_identity_pub BLOB NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', joined_at INTEGER NOT NULL
    );
    CREATE TABLE contacts(
      id TEXT PRIMARY KEY, display_name TEXT, avatar_ref TEXT,
      verification_state TEXT NOT NULL DEFAULT 'unverified',
      profile_key_epoch INTEGER NOT NULL DEFAULT 0,
      is_friend INTEGER NOT NULL DEFAULT 0,
      blocked_hidden INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE contact_relays(
      contact_id TEXT NOT NULL REFERENCES contacts(id),
      relay_id TEXT NOT NULL REFERENCES relays(id),
      handle TEXT NOT NULL, identity_pub BLOB NOT NULL,
      via_attestation INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(contact_id, relay_id)
    );
    CREATE TABLE conversations(
      id TEXT PRIMARY KEY, type TEXT NOT NULL,
      relay_id TEXT REFERENCES relays(id),
      group_state_json TEXT, group_state_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE messages(
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      channel_id TEXT, sender_contact_id TEXT,
      relay_ts INTEGER NOT NULL, content TEXT, kind TEXT NOT NULL,
      reply_ref_json TEXT, attachments_json TEXT,
      deleted INTEGER NOT NULL DEFAULT 0, edited_at INTEGER
    );
    CREATE INDEX idx_messages_sort
      ON messages(conversation_id, channel_id, relay_ts, sender_contact_id, id);
    CREATE TABLE crdt_docs(
      id TEXT PRIMARY KEY, scope TEXT NOT NULL,
      ydoc_state BLOB, state_vector BLOB, compacted_at INTEGER
    );
    CREATE TABLE crdt_updates(
      doc_id TEXT NOT NULL REFERENCES crdt_docs(id),
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      update_blob BLOB NOT NULL, origin TEXT NOT NULL, created INTEGER NOT NULL
    );
    CREATE TABLE notes(
      id TEXT PRIMARY KEY, title TEXT, doc_id TEXT REFERENCES crdt_docs(id),
      folder_id TEXT, shared_json TEXT,
      created INTEGER NOT NULL, updated INTEGER NOT NULL
    );
    CREATE TABLE note_versions(
      note_id TEXT NOT NULL REFERENCES notes(id),
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot BLOB NOT NULL, kind TEXT NOT NULL, name TEXT,
      created INTEGER NOT NULL
    );
    CREATE TABLE attachments(
      id TEXT PRIMARY KEY, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,
      file_key BLOB NOT NULL, path TEXT, thumb BLOB,
      size INTEGER, mime TEXT, content_hash TEXT,
      state TEXT NOT NULL DEFAULT 'present'
    );
    CREATE TABLE outbox(
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
      envelope BLOB NOT NULL, relay_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      created INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE sync_cursors(
      relay_id TEXT PRIMARY KEY REFERENCES relays(id),
      mailbox_cursor TEXT, kt_epoch_seen INTEGER
    );
    CREATE TABLE eviction_watermarks(
      conversation_id TEXT PRIMARY KEY,
      evicted_before_ts INTEGER NOT NULL, mode TEXT NOT NULL
    );
    CREATE TABLE own_devices(
      device_id TEXT PRIMARY KEY, name TEXT, platform TEXT,
      added_at INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'full'
    );
    CREATE TABLE kt_state(
      relay_id TEXT PRIMARY KEY REFERENCES relays(id),
      own_binding_proof BLOB, last_root BLOB
    );
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    ",
    // v2 — FTS5 search (external-content tables + sync triggers). `notes`
    // gains `search_text`: the plaintext projection of the Yjs doc, written by
    // the notes engine on save so note bodies are searchable without loading
    // docs (D2: search is the reason rows are decrypted under SQLCipher).
    "
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      content, content='messages', content_rowid='rowid'
    );
    CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES ('delete', old.rowid, old.content);
    END;
    CREATE TRIGGER messages_fts_au AFTER UPDATE OF content ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES ('delete', old.rowid, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    ALTER TABLE notes ADD COLUMN search_text TEXT;
    CREATE VIRTUAL TABLE notes_fts USING fts5(
      title, search_text, content='notes', content_rowid='rowid'
    );
    CREATE TRIGGER notes_fts_ai AFTER INSERT ON notes BEGIN
      INSERT INTO notes_fts(rowid, title, search_text)
        VALUES (new.rowid, new.title, new.search_text);
    END;
    CREATE TRIGGER notes_fts_ad AFTER DELETE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, search_text)
        VALUES ('delete', old.rowid, old.title, old.search_text);
    END;
    CREATE TRIGGER notes_fts_au AFTER UPDATE OF title, search_text ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, search_text)
        VALUES ('delete', old.rowid, old.title, old.search_text);
      INSERT INTO notes_fts(rowid, title, search_text)
        VALUES (new.rowid, new.title, new.search_text);
    END;
    ",
];

pub struct Store {
    conn: Connection,
}

impl Store {
    /// Open (or create) the encrypted store with a raw 32-byte SQLCipher key.
    pub fn open(path: &Path, key: &[u8; 32]) -> Result<Self, StoreError> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "key", format!("x'{}'", hex(key)))?;
        // First read fails on a wrong key (SQLCipher can't decrypt page 1).
        conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| {
            r.get::<_, i64>(0)
        })
        .map_err(|_| StoreError::BadKey)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let store = Self { conn };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> Result<(), StoreError> {
        let current: i64 =
            self.conn
                .query_row("PRAGMA user_version", [], |r| r.get(0))?;
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
            self.conn.execute_batch(&format!(
                "BEGIN; {sql}; PRAGMA user_version = {}; COMMIT;",
                i + 1
            ))?;
        }
        Ok(())
    }

    pub fn schema_version(&self) -> Result<i64, StoreError> {
        Ok(self
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))?)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO settings(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )?;
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>, StoreError> {
        Ok(self
            .conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                e => Err(e),
            })?)
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_migrate_reopen_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.db");
        let key = [7u8; 32];

        let store = Store::open(&path, &key).unwrap();
        assert_eq!(store.schema_version().unwrap(), MIGRATIONS.len() as i64);
        store.set_setting("theme", "dark").unwrap();
        drop(store);

        let store = Store::open(&path, &key).unwrap();
        assert_eq!(store.get_setting("theme").unwrap().as_deref(), Some("dark"));
        assert_eq!(store.get_setting("missing").unwrap(), None);
    }

    #[test]
    fn wrong_key_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.db");
        Store::open(&path, &[1u8; 32]).unwrap();
        assert!(matches!(
            Store::open(&path, &[2u8; 32]),
            Err(StoreError::BadKey)
        ));
    }

    /// Message search stays consistent through insert, edit, and delete —
    /// the external-content FTS table is maintained entirely by triggers.
    #[test]
    fn message_fts_tracks_insert_update_delete() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("vault.db"), &[3u8; 32]).unwrap();
        store
            .conn
            .execute_batch(
                "INSERT INTO conversations(id, type) VALUES ('c1', 'dm');
                 INSERT INTO messages(id, conversation_id, relay_ts, content, kind)
                   VALUES ('m1', 'c1', 1000, 'the quick brown fox', 'text');",
            )
            .unwrap();
        let count = |q: &str| -> i64 {
            store
                .conn
                .query_row(
                    "SELECT count(*) FROM messages_fts WHERE messages_fts MATCH ?1",
                    [q],
                    |r| r.get(0),
                )
                .unwrap()
        };
        assert_eq!(count("quick"), 1);

        store
            .conn
            .execute("UPDATE messages SET content = 'slow green turtle' WHERE id = 'm1'", [])
            .unwrap();
        assert_eq!(count("quick"), 0);
        assert_eq!(count("turtle"), 1);

        store.conn.execute("DELETE FROM messages WHERE id = 'm1'", []).unwrap();
        assert_eq!(count("turtle"), 0);
    }

    #[test]
    fn note_fts_searches_title_and_body_projection() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("vault.db"), &[4u8; 32]).unwrap();
        store
            .conn
            .execute(
                "INSERT INTO notes(id, title, search_text, created, updated)
                 VALUES ('n1', 'Grocery list', 'buy oat milk and rye bread', 1, 1)",
                [],
            )
            .unwrap();
        let hits: i64 = store
            .conn
            .query_row(
                "SELECT count(*) FROM notes_fts WHERE notes_fts MATCH 'rye'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1);
    }

    #[test]
    fn migrations_are_idempotent_on_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.db");
        let key = [9u8; 32];
        Store::open(&path, &key).unwrap();
        let store = Store::open(&path, &key).unwrap();
        assert_eq!(store.schema_version().unwrap(), MIGRATIONS.len() as i64);
    }
}
