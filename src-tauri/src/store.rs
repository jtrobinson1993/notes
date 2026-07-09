//! SQLCipher-encrypted local store (spec/local-store.md).
//!
//! The whole DB — rows, indexes, metadata — is encrypted at rest (roadmap D2).
//! Decrypted content lives in rows so local search can work; the at-rest
//! boundary is the SQLCipher key, never field-level ciphertext.

use rusqlite::{Connection, OptionalExtension};

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
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
    // v3 — legacy attachments are AES-GCM with an external 12-byte IV carried
    // in their AttachmentRef; store it beside the key.
    "ALTER TABLE attachments ADD COLUMN iv BLOB;",
    // v4 — retain each note's E2E key (own notes: unwrapped from MK; shared
    // notes: unsealed). Needed again in phase 4 when note updates sync over
    // the relay under the per-note key; SQLCipher protects it at rest.
    "ALTER TABLE notes ADD COLUMN note_key BLOB;",
    // v5 — natural key for versions so the (retry-safe) migration can INSERT
    // OR IGNORE without duplicating snapshots on re-run.
    "CREATE UNIQUE INDEX ux_note_versions ON note_versions(note_id, kind, created);",
    // v6 — tags as first-class metadata (the UI filters on them; they were
    // only folded into search_text before).
    "ALTER TABLE notes ADD COLUMN tags_json TEXT;",
    // v7 — v8 friend addressing (D4b/D6): a contact's per-relay sealing key (to
    // seal envelopes to them) + delivery token (to send via the sealed
    // mailbox), established on invite redemption / friend-accept.
    "ALTER TABLE contact_relays ADD COLUMN sealing_pub BLOB;
     ALTER TABLE contact_relays ADD COLUMN delivery_token TEXT;",
    // v8 — per-conversation read marker (local unread tracking, D11).
    "ALTER TABLE conversations ADD COLUMN last_read_ts INTEGER NOT NULL DEFAULT 0;",
    // v9 — message reactions (D11 overlay): one row per (message, reactor,
    // emoji). reactor_id is 'self' for mine, else the reactor's identity key.
    "CREATE TABLE message_reactions(
       message_id TEXT NOT NULL, reactor_id TEXT NOT NULL, emoji TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       PRIMARY KEY(message_id, reactor_id, emoji)
     );",
];

#[derive(serde::Deserialize)]
pub struct ImportNote {
    pub id: String,
    pub title: Option<String>,
    pub search_text: Option<String>,
    pub folder_id: Option<String>,
    pub created: i64,
    pub updated: i64,
    /// Yjs doc binary, built webview-side from the decrypted legacy note.
    pub ydoc_state: Vec<u8>,
    /// `{ owner, access }` for shared-with-me notes; None for own notes.
    pub shared_json: Option<String>,
    /// The note's E2E key (unwrapped/unsealed during migration).
    pub note_key: Option<Vec<u8>>,
    /// JSON string[] of the note's tags.
    pub tags_json: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct ImportNoteVersion {
    pub note_id: String,
    /// `legacy` for imported v2 server snapshots (read-only, per D10).
    pub kind: String,
    pub name: Option<String>,
    pub created: i64,
    /// JSON `{title, body}` snapshot bytes.
    pub snapshot: Vec<u8>,
}

#[derive(serde::Deserialize)]
pub struct ImportConversation {
    pub id: String,
    /// `dm` | `group` (field named `type` on the wire).
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(serde::Deserialize)]
pub struct ImportContact {
    pub id: String,
    pub display_name: Option<String>,
    pub is_friend: bool,
}

/// A v8 friend's per-relay addressing to record on invite redeem / friend-accept.
#[derive(serde::Deserialize)]
pub struct FriendRecord {
    pub contact_id: String,
    pub display_name: Option<String>,
    pub relay_id: String,
    pub handle: String,
    /// Friend's per-relay Ed25519 identity key.
    pub identity_pub: Vec<u8>,
    /// Friend's X25519 sealing key (seal envelopes to this).
    pub sealing_pub: Vec<u8>,
    /// Capability to send to the friend via the sealed mailbox (D6).
    pub delivery_token: String,
}

/// Everything needed to seal + send to a friend on a relay.
#[derive(serde::Serialize)]
pub struct FriendAddressing {
    pub handle: String,
    pub identity_pub: Vec<u8>,
    pub sealing_pub: Vec<u8>,
    pub delivery_token: String,
}

/// A friend list entry.
#[derive(serde::Serialize)]
pub struct FriendSummary {
    pub contact_id: String,
    pub handle: String,
    pub display_name: Option<String>,
}

/// One reaction on a message (the UI groups by emoji + flags mine).
#[derive(serde::Serialize)]
pub struct ReactionRow {
    pub message_id: String,
    pub emoji: String,
    /// `self` for mine, else the reactor's identity key.
    pub reactor_id: String,
}

#[derive(serde::Deserialize)]
pub struct ImportMessage {
    pub id: String,
    pub conversation_id: String,
    pub channel_id: Option<String>,
    pub sender_contact_id: Option<String>,
    pub relay_ts: i64,
    pub content: Option<String>,
    pub kind: String,
    pub reply_ref_json: Option<String>,
    pub attachments_json: Option<String>,
    pub edited_at: Option<i64>,
}

#[derive(serde::Serialize)]
pub struct MessageRow {
    pub id: String,
    pub conversation_id: String,
    pub channel_id: Option<String>,
    pub sender_contact_id: Option<String>,
    pub relay_ts: i64,
    pub content: Option<String>,
    pub kind: String,
    pub reply_ref_json: Option<String>,
    pub attachments_json: Option<String>,
    pub deleted: bool,
    pub edited_at: Option<i64>,
}

#[derive(serde::Serialize)]
pub struct NoteMeta {
    pub id: String,
    pub title: Option<String>,
    pub folder_id: Option<String>,
    pub shared_json: Option<String>,
    pub tags_json: Option<String>,
    pub created: i64,
    pub updated: i64,
}

#[derive(serde::Serialize)]
pub struct NoteDoc {
    pub meta: NoteMeta,
    pub ydoc_state: Option<Vec<u8>>,
}

#[derive(serde::Deserialize)]
pub struct AttachmentMeta {
    pub id: String,
    pub owner_kind: String,
    pub owner_id: String,
    /// The per-file key from the E2E payload (protected at rest by SQLCipher).
    pub file_key: Vec<u8>,
    /// AES-GCM IV for the blob (legacy refs carry it separately).
    pub iv: Option<Vec<u8>>,
    pub thumb: Option<Vec<u8>>,
    pub size: Option<i64>,
    pub mime: Option<String>,
    pub content_hash: Option<String>,
}

#[derive(serde::Serialize)]
pub struct AttachmentRow {
    pub id: String,
    pub owner_kind: String,
    pub owner_id: String,
    pub file_key: Vec<u8>,
    pub iv: Option<Vec<u8>>,
    pub thumb: Option<Vec<u8>>,
    pub size: Option<i64>,
    pub mime: Option<String>,
    pub content_hash: Option<String>,
    pub state: String,
}

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

    /// Batch-import legacy notes (spec/migration.md): the webview decrypts
    /// with the existing v1 crypto and seeds each note as a Yjs doc binary;
    /// the core stores rows + opaque doc state. `INSERT OR IGNORE` keeps
    /// re-runs after a partial failure idempotent (first copy wins; the FTS
    /// triggers stay consistent, which OR REPLACE would break).
    pub fn import_notes(&self, notes: Vec<ImportNote>) -> Result<usize, StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        let mut imported = 0;
        for n in notes {
            let doc_id = format!("note:{}", n.id);
            tx.execute(
                "INSERT OR IGNORE INTO crdt_docs(id, scope, ydoc_state) VALUES (?1, 'note', ?2)",
                (&doc_id, &n.ydoc_state),
            )?;
            imported += tx.execute(
                "INSERT OR IGNORE INTO notes(
                   id, title, doc_id, folder_id, search_text, created, updated,
                   shared_json, note_key, tags_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                (
                    &n.id,
                    &n.title,
                    &doc_id,
                    &n.folder_id,
                    &n.search_text,
                    n.created,
                    n.updated,
                    &n.shared_json,
                    &n.note_key,
                    &n.tags_json,
                ),
            )?;
        }
        tx.commit()?;
        Ok(imported)
    }

    pub fn import_note_versions(
        &self,
        versions: Vec<ImportNoteVersion>,
    ) -> Result<usize, StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        let mut imported = 0;
        for v in versions {
            imported += tx.execute(
                "INSERT OR IGNORE INTO note_versions(note_id, kind, name, created, snapshot)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                (&v.note_id, &v.kind, &v.name, v.created, &v.snapshot),
            )?;
        }
        tx.commit()?;
        Ok(imported)
    }

    pub fn import_conversations(
        &self,
        conversations: Vec<ImportConversation>,
    ) -> Result<usize, StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        let mut imported = 0;
        for c in conversations {
            imported += tx.execute(
                "INSERT OR IGNORE INTO conversations(id, type) VALUES (?1, ?2)",
                (&c.id, &c.kind),
            )?;
        }
        tx.commit()?;
        Ok(imported)
    }

    pub fn import_contacts(&self, contacts: Vec<ImportContact>) -> Result<usize, StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        let mut imported = 0;
        for c in contacts {
            imported += tx.execute(
                "INSERT OR IGNORE INTO contacts(id, display_name, is_friend) VALUES (?1, ?2, ?3)",
                (&c.id, &c.display_name, c.is_friend as i64),
            )?;
        }
        tx.commit()?;
        Ok(imported)
    }

    /// Persist (idempotently) a relay this device is a member of, so friend and
    /// conversation rows can reference it (D4/local-store).
    pub fn upsert_relay(
        &self,
        relay_id: &str,
        url: &str,
        identity_fp: &str,
        our_identity_pub: &[u8],
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO relays(id, url, identity_fp, our_identity_pub, joined_at)
               VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET url = excluded.url,
               identity_fp = excluded.identity_fp,
               our_identity_pub = excluded.our_identity_pub",
            (relay_id, url, identity_fp, our_identity_pub, now_ms()),
        )?;
        Ok(())
    }

    /// Ensure a conversation row exists (idempotent), so messages — which FK to
    /// it — can be inserted. For a v8 DM the id is `identity::dm_conversation_id`.
    pub fn ensure_conversation(
        &self,
        id: &str,
        conv_type: &str,
        relay_id: &str,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT OR IGNORE INTO conversations(id, type, relay_id) VALUES (?1, ?2, ?3)",
            (id, conv_type, relay_id),
        )?;
        Ok(())
    }

    /// Record (or refresh) a v8 friend's per-relay addressing (D4b/D6): the
    /// contact is marked a friend and gains everything needed to reach them —
    /// handle, identity key, sealing key, and delivery token. Idempotent; the
    /// relay row must already exist (see `upsert_relay`).
    pub fn record_friend(&self, f: &FriendRecord) -> Result<(), StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO contacts(id, display_name, is_friend) VALUES (?1, ?2, 1)
             ON CONFLICT(id) DO UPDATE SET is_friend = 1,
               display_name = COALESCE(excluded.display_name, contacts.display_name)",
            (&f.contact_id, &f.display_name),
        )?;
        tx.execute(
            "INSERT INTO contact_relays(contact_id, relay_id, handle, identity_pub, sealing_pub, delivery_token)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(contact_id, relay_id) DO UPDATE SET handle = excluded.handle,
               identity_pub = excluded.identity_pub, sealing_pub = excluded.sealing_pub,
               delivery_token = excluded.delivery_token",
            (
                &f.contact_id,
                &f.relay_id,
                &f.handle,
                &f.identity_pub,
                &f.sealing_pub,
                &f.delivery_token,
            ),
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Everything needed to seal + send to a friend on a relay, or None if not a
    /// friend there (or addressing not yet exchanged).
    pub fn friend_addressing(
        &self,
        contact_id: &str,
        relay_id: &str,
    ) -> Result<Option<FriendAddressing>, StoreError> {
        let row = self
            .conn
            .query_row(
                "SELECT cr.handle, cr.identity_pub, cr.sealing_pub, cr.delivery_token
                   FROM contact_relays cr JOIN contacts c ON c.id = cr.contact_id
                  WHERE cr.contact_id = ?1 AND cr.relay_id = ?2 AND c.is_friend = 1
                    AND cr.sealing_pub IS NOT NULL AND cr.delivery_token IS NOT NULL",
                (contact_id, relay_id),
                |r| {
                    Ok(FriendAddressing {
                        handle: r.get(0)?,
                        identity_pub: r.get(1)?,
                        sealing_pub: r.get(2)?,
                        delivery_token: r.get(3)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    /// List v8 friends on a relay (for the friends list + starting DMs).
    pub fn list_friends(&self, relay_id: &str) -> Result<Vec<FriendSummary>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT cr.contact_id, cr.handle, c.display_name
               FROM contact_relays cr JOIN contacts c ON c.id = cr.contact_id
              WHERE cr.relay_id = ?1 AND c.is_friend = 1 AND c.blocked_hidden = 0
                AND cr.delivery_token IS NOT NULL
              ORDER BY cr.handle",
        )?;
        let rows = stmt
            .query_map((relay_id,), |r| {
                Ok(FriendSummary {
                    contact_id: r.get(0)?,
                    handle: r.get(1)?,
                    display_name: r.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Unfriend (D4b — the local half; the caller rotates the profile key +
    /// re-issues tokens to remaining friends). Drops the friend flag and their
    /// addressing so we can no longer reach them.
    pub fn remove_friend(&self, contact_id: &str, relay_id: &str) -> Result<(), StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE contact_relays SET sealing_pub = NULL, delivery_token = NULL
              WHERE contact_id = ?1 AND relay_id = ?2",
            (contact_id, relay_id),
        )?;
        tx.execute("UPDATE contacts SET is_friend = 0 WHERE id = ?1", (contact_id,))?;
        tx.commit()?;
        Ok(())
    }

    pub fn import_messages(&self, messages: Vec<ImportMessage>) -> Result<usize, StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        let mut imported = 0;
        for m in messages {
            imported += tx.execute(
                "INSERT OR IGNORE INTO messages(
                   id, conversation_id, channel_id, sender_contact_id, relay_ts,
                   content, kind, reply_ref_json, attachments_json, edited_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                (
                    &m.id,
                    &m.conversation_id,
                    &m.channel_id,
                    &m.sender_contact_id,
                    m.relay_ts,
                    &m.content,
                    &m.kind,
                    &m.reply_ref_json,
                    &m.attachments_json,
                    m.edited_at,
                ),
            )?;
        }
        tx.commit()?;
        Ok(imported)
    }

    // ---- chat history (local log, D11 ordering) ----

    /// Page a conversation's history backwards by the D11 sort key
    /// `(relay_ts, sender, id)`. `before` = exclusive cursor from the oldest
    /// row of the previous page; None = newest page.
    pub fn messages_page(
        &self,
        conversation_id: &str,
        channel_id: Option<&str>,
        before: Option<(i64, String)>,
        limit: u32,
    ) -> Result<Vec<MessageRow>, StoreError> {
        // channel_id NULL = the general channel (equals the conversation id
        // in the legacy model); a distinct id = an extra group channel.
        let (cursor_ts, cursor_id) = match &before {
            Some((ts, id)) => (*ts, id.clone()),
            None => (i64::MAX, String::from("\u{10FFFF}")),
        };
        let mut stmt = self.conn.prepare(
            "SELECT id, conversation_id, channel_id, sender_contact_id, relay_ts,
                    content, kind, reply_ref_json, attachments_json, deleted, edited_at
             FROM messages
             WHERE conversation_id = ?1
               AND ((?2 IS NULL AND channel_id IS NULL) OR channel_id = ?2)
               AND (relay_ts, id) < (?3, ?4)
             ORDER BY relay_ts DESC, sender_contact_id DESC, id DESC
             LIMIT ?5",
        )?;
        let rows = stmt
            .query_map(
                rusqlite::params![conversation_id, channel_id, cursor_ts, cursor_id, limit],
                |r| {
                    Ok(MessageRow {
                        id: r.get(0)?,
                        conversation_id: r.get(1)?,
                        channel_id: r.get(2)?,
                        sender_contact_id: r.get(3)?,
                        relay_ts: r.get(4)?,
                        content: r.get(5)?,
                        kind: r.get(6)?,
                        reply_ref_json: r.get(7)?,
                        attachments_json: r.get(8)?,
                        deleted: r.get::<_, i64>(9)? != 0,
                        edited_at: r.get(10)?,
                    })
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Live-ingest an edit (author replaced their content in place).
    pub fn message_apply_edit(
        &self,
        id: &str,
        content: Option<&str>,
        edited_at: i64,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE messages SET content = ?2, edited_at = ?3 WHERE id = ?1",
            (id, content, edited_at),
        )?;
        Ok(())
    }

    /// Live-ingest a delete: content is dropped, the row stays as the
    /// "message deleted" placeholder (D11 tombstone rendering).
    pub fn message_apply_delete(&self, id: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE messages SET content = NULL, deleted = 1 WHERE id = ?1",
            [id],
        )?;
        Ok(())
    }

    /// Add a reaction (idempotent by (message, reactor, emoji)).
    pub fn add_reaction(&self, message_id: &str, reactor_id: &str, emoji: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT OR IGNORE INTO message_reactions(message_id, reactor_id, emoji, created_at)
               VALUES (?1, ?2, ?3, ?4)",
            (message_id, reactor_id, emoji, now_ms()),
        )?;
        Ok(())
    }

    /// Remove a reaction.
    pub fn remove_reaction(&self, message_id: &str, reactor_id: &str, emoji: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "DELETE FROM message_reactions WHERE message_id = ?1 AND reactor_id = ?2 AND emoji = ?3",
            (message_id, reactor_id, emoji),
        )?;
        Ok(())
    }

    /// All reactions on a conversation's messages (the UI groups by emoji).
    pub fn conversation_reactions(&self, conversation_id: &str) -> Result<Vec<ReactionRow>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT r.message_id, r.emoji, r.reactor_id
               FROM message_reactions r JOIN messages m ON m.id = r.message_id
              WHERE m.conversation_id = ?1
              ORDER BY r.created_at",
        )?;
        let rows = stmt
            .query_map((conversation_id,), |r| {
                Ok(ReactionRow {
                    message_id: r.get(0)?,
                    emoji: r.get(1)?,
                    reactor_id: r.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Mark a conversation read up to its newest message (local unread, D11).
    pub fn mark_conversation_read(&self, conversation_id: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE conversations SET last_read_ts = COALESCE(
               (SELECT MAX(relay_ts) FROM messages WHERE conversation_id = ?1), last_read_ts)
             WHERE id = ?1",
            [conversation_id],
        )?;
        Ok(())
    }

    /// Count of unread inbound (not-mine, not-deleted) messages in a conversation
    /// — messages newer than its read marker.
    pub fn conversation_unread(&self, conversation_id: &str) -> Result<i64, StoreError> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM messages m
               JOIN conversations c ON c.id = m.conversation_id
              WHERE m.conversation_id = ?1 AND m.relay_ts > c.last_read_ts
                AND m.deleted = 0
                AND (m.sender_contact_id IS NULL OR m.sender_contact_id != 'self')",
            [conversation_id],
            |r| r.get(0),
        )?)
    }

    /// The `sender_contact_id` of a message, or None if unknown — the authority
    /// check for an inbound edit/delete (only the original sender may change it).
    pub fn message_sender(&self, id: &str) -> Result<Option<String>, StoreError> {
        Ok(self
            .conn
            .query_row(
                "SELECT sender_contact_id FROM messages WHERE id = ?1",
                [id],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }

    // ---- notes CRUD (the local-first read/write path, D2) ----

    pub fn list_notes(&self) -> Result<Vec<NoteMeta>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, folder_id, shared_json, tags_json, created, updated
             FROM notes ORDER BY updated DESC",
        )?;
        let rows = stmt
            .query_map([], map_note_meta)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Bulk load for app startup: every note's meta + doc state in one call
    /// (the UI holds all decrypted notes in memory, mirroring the web path).
    pub fn load_notes_with_docs(&self) -> Result<Vec<NoteDoc>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT n.id, n.title, n.folder_id, n.shared_json, n.tags_json, n.created, n.updated,
                    d.ydoc_state
             FROM notes n LEFT JOIN crdt_docs d ON d.id = n.doc_id
             ORDER BY n.updated DESC",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(NoteDoc {
                    meta: map_note_meta(r)?,
                    ydoc_state: r.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_note(&self, id: &str) -> Result<Option<NoteDoc>, StoreError> {
        Ok(self
            .conn
            .query_row(
                "SELECT n.id, n.title, n.folder_id, n.shared_json, n.tags_json, n.created, n.updated,
                        d.ydoc_state
                 FROM notes n LEFT JOIN crdt_docs d ON d.id = n.doc_id
                 WHERE n.id = ?1",
                [id],
                |r| {
                    Ok(NoteDoc {
                        meta: map_note_meta(r)?,
                        ydoc_state: r.get(7)?,
                    })
                },
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                e => Err(e),
            })?)
    }

    pub fn create_note(&self, id: &str, now: i64) -> Result<(), StoreError> {
        let doc_id = format!("note:{id}");
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO crdt_docs(id, scope) VALUES (?1, 'note')",
            [&doc_id],
        )?;
        tx.execute(
            "INSERT INTO notes(id, title, doc_id, created, updated) VALUES (?1, '', ?2, ?3, ?3)",
            (id, &doc_id, now),
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Persist an edit: the webview owns the Y.Doc and sends its full encoded
    /// state (delta persistence arrives with the phase-4 sync engine) plus
    /// the display title + plaintext search projection.
    pub fn save_note(
        &self,
        id: &str,
        title: &str,
        search_text: &str,
        tags_json: &str,
        ydoc_state: &[u8],
        now: i64,
    ) -> Result<(), StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        let changed = tx.execute(
            "UPDATE notes SET title = ?2, search_text = ?3, tags_json = ?4, updated = ?5
             WHERE id = ?1",
            (id, title, search_text, tags_json, now),
        )?;
        if changed == 0 {
            return Err(StoreError::Db(rusqlite::Error::QueryReturnedNoRows));
        }
        tx.execute(
            "UPDATE crdt_docs SET ydoc_state = ?2
             WHERE id = (SELECT doc_id FROM notes WHERE id = ?1)",
            (id, ydoc_state),
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn delete_note(&self, id: &str) -> Result<(), StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        // FK order: versions reference the note, the note references its doc.
        let doc_id: Option<String> = tx
            .query_row("SELECT doc_id FROM notes WHERE id = ?1", [id], |r| r.get(0))
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                e => Err(e),
            })?;
        tx.execute("DELETE FROM note_versions WHERE note_id = ?1", [id])?;
        tx.execute("DELETE FROM notes WHERE id = ?1", [id])?;
        if let Some(doc_id) = doc_id {
            tx.execute("DELETE FROM crdt_docs WHERE id = ?1", [&doc_id])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn search_notes(&self, query: &str) -> Result<Vec<NoteMeta>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT n.id, n.title, n.folder_id, n.shared_json, n.tags_json, n.created, n.updated
             FROM notes_fts f JOIN notes n ON n.rowid = f.rowid
             WHERE notes_fts MATCH ?1 ORDER BY rank",
        )?;
        let rows = stmt
            .query_map([query], map_note_meta)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn insert_attachment(&self, a: &AttachmentMeta, path: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT OR IGNORE INTO attachments(
               id, owner_kind, owner_id, file_key, iv, path, thumb, size, mime, content_hash, state)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'present')",
            (
                &a.id,
                &a.owner_kind,
                &a.owner_id,
                &a.file_key,
                &a.iv,
                path,
                &a.thumb,
                a.size,
                &a.mime,
                &a.content_hash,
            ),
        )?;
        Ok(())
    }

    pub fn has_attachment(&self, id: &str) -> Result<bool, StoreError> {
        Ok(self.attachment_meta(id)?.is_some())
    }

    pub fn attachment_meta(&self, id: &str) -> Result<Option<AttachmentRow>, StoreError> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, owner_kind, owner_id, file_key, iv, thumb, size, mime, content_hash, state
                 FROM attachments WHERE id = ?1",
                [id],
                |r| {
                    Ok(AttachmentRow {
                        id: r.get(0)?,
                        owner_kind: r.get(1)?,
                        owner_id: r.get(2)?,
                        file_key: r.get(3)?,
                        iv: r.get(4)?,
                        thumb: r.get(5)?,
                        size: r.get(6)?,
                        mime: r.get(7)?,
                        content_hash: r.get(8)?,
                        state: r.get(9)?,
                    })
                },
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                e => Err(e),
            })?)
    }

    pub fn set_attachment_state(&self, id: &str, state: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE attachments SET state = ?2, path = CASE WHEN ?2 = 'present' THEN path ELSE NULL END
             WHERE id = ?1",
            (id, state),
        )?;
        Ok(())
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

fn map_note_meta(r: &rusqlite::Row) -> rusqlite::Result<NoteMeta> {
    Ok(NoteMeta {
        id: r.get(0)?,
        title: r.get(1)?,
        folder_id: r.get(2)?,
        shared_json: r.get(3)?,
        tags_json: r.get(4)?,
        created: r.get(5)?,
        updated: r.get(6)?,
    })
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
    fn import_batches_are_idempotent_and_fts_searchable() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("vault.db"), &[5u8; 32]).unwrap();

        let notes = vec![ImportNote {
            id: "n1".into(),
            title: Some("Meeting notes".into()),
            search_text: Some("discuss quarterly sqlcipher rollout".into()),
            folder_id: None,
            created: 1,
            updated: 2,
            ydoc_state: vec![1, 2, 3],
            shared_json: Some(r#"{"owner":"Alice","access":"edit"}"#.into()),
            note_key: Some(vec![7u8; 32]),
            tags_json: Some(r#"["work"]"#.into()),
        }];
        assert_eq!(store.import_notes(notes).unwrap(), 1);

        // Version snapshots dedupe on (note_id, kind, created) across re-runs.
        let version = || ImportNoteVersion {
            note_id: "n1".into(),
            kind: "legacy".into(),
            name: None,
            created: 42,
            snapshot: br#"{"title":"t","body":"b"}"#.to_vec(),
        };
        assert_eq!(store.import_note_versions(vec![version()]).unwrap(), 1);
        assert_eq!(store.import_note_versions(vec![version()]).unwrap(), 0);

        store
            .import_conversations(vec![ImportConversation {
                id: "c1".into(),
                kind: "dm".into(),
            }])
            .unwrap();
        store
            .import_contacts(vec![ImportContact {
                id: "u1".into(),
                display_name: Some("Alice".into()),
                is_friend: true,
            }])
            .unwrap();
        let msg = ImportMessage {
            id: "m1".into(),
            conversation_id: "c1".into(),
            channel_id: None,
            sender_contact_id: Some("u1".into()),
            relay_ts: 1000,
            content: Some("migrated hello".into()),
            kind: "text".into(),
            reply_ref_json: None,
            attachments_json: None,
            edited_at: None,
        };
        assert_eq!(store.import_messages(vec![msg]).unwrap(), 1);

        // Re-running the same batch is a no-op (partial-failure retry safety).
        let again = ImportMessage {
            id: "m1".into(),
            conversation_id: "c1".into(),
            channel_id: None,
            sender_contact_id: Some("u1".into()),
            relay_ts: 1000,
            content: Some("migrated hello".into()),
            kind: "text".into(),
            reply_ref_json: None,
            attachments_json: None,
            edited_at: None,
        };
        assert_eq!(store.import_messages(vec![again]).unwrap(), 0);

        // Imported content is immediately searchable (FTS triggers fired).
        let hits: i64 = store
            .conn
            .query_row(
                "SELECT count(*) FROM messages_fts WHERE messages_fts MATCH 'migrated'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1);
        let note_hits: i64 = store
            .conn
            .query_row(
                "SELECT count(*) FROM notes_fts WHERE notes_fts MATCH 'sqlcipher'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(note_hits, 1);
    }

    #[test]
    fn message_paging_edits_and_deletes() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("vault.db"), &[10u8; 32]).unwrap();
        store
            .import_conversations(vec![ImportConversation {
                id: "c1".into(),
                kind: "dm".into(),
            }])
            .unwrap();
        let msg = |id: &str, ts: i64| ImportMessage {
            id: id.into(),
            conversation_id: "c1".into(),
            channel_id: None,
            sender_contact_id: Some("u1".into()),
            relay_ts: ts,
            content: Some(format!("msg {id}")),
            kind: "text".into(),
            reply_ref_json: None,
            attachments_json: None,
            edited_at: None,
        };
        store
            .import_messages((1..=5).map(|i| msg(&format!("m{i}"), i * 100)).collect())
            .unwrap();

        // Newest page first, D11 order.
        let page1 = store.messages_page("c1", None, None, 2).unwrap();
        assert_eq!(
            page1.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["m5", "m4"]
        );
        // Cursor from the oldest row continues without overlap.
        let cursor = Some((page1[1].relay_ts, page1[1].id.clone()));
        let page2 = store.messages_page("c1", None, cursor, 2).unwrap();
        assert_eq!(
            page2.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["m3", "m2"]
        );

        store.message_apply_edit("m5", Some("edited"), 999).unwrap();
        store.message_apply_delete("m4").unwrap();
        let page = store.messages_page("c1", None, None, 2).unwrap();
        assert_eq!(page[0].content.as_deref(), Some("edited"));
        assert_eq!(page[0].edited_at, Some(999));
        assert!(page[1].deleted);
        assert_eq!(page[1].content, None);
    }

    #[test]
    fn note_crud_lifecycle_with_fts() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("vault.db"), &[8u8; 32]).unwrap();

        store.create_note("n1", 100).unwrap();
        store
            .save_note("n1", "Rocket plans", "flight to the moon", r#"["space"]"#, &[1, 2, 3], 200)
            .unwrap();

        let list = store.list_notes().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title.as_deref(), Some("Rocket plans"));
        assert_eq!(list[0].tags_json.as_deref(), Some(r#"["space"]"#));
        assert_eq!(list[0].updated, 200);

        let doc = store.get_note("n1").unwrap().unwrap();
        assert_eq!(doc.ydoc_state.as_deref(), Some(&[1u8, 2, 3][..]));

        let all = store.load_notes_with_docs().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].ydoc_state.as_deref(), Some(&[1u8, 2, 3][..]));

        let hits = store.search_notes("moon").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "n1");

        // Saving an unknown note errors rather than silently no-oping.
        assert!(store.save_note("nope", "t", "s", "[]", &[], 1).is_err());

        store.delete_note("n1").unwrap();
        assert!(store.get_note("n1").unwrap().is_none());
        assert_eq!(store.search_notes("moon").unwrap().len(), 0);
        let docs: i64 = store
            .conn
            .query_row("SELECT count(*) FROM crdt_docs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(docs, 0);
    }

    #[test]
    fn attachment_rows_track_state_through_evict() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("vault.db"), &[6u8; 32]).unwrap();
        let meta = AttachmentMeta {
            id: "att1".into(),
            owner_kind: "message".into(),
            owner_id: "m1".into(),
            file_key: vec![1u8; 32],
            iv: Some(vec![2u8; 12]),
            thumb: None,
            size: Some(1234),
            mime: Some("image/webp".into()),
            content_hash: Some("h".into()),
        };
        store.insert_attachment(&meta, "/blobs/at/att1").unwrap();

        let row = store.attachment_meta("att1").unwrap().unwrap();
        assert_eq!(row.state, "present");
        assert_eq!(row.file_key, vec![1u8; 32]);
        assert_eq!(row.iv, Some(vec![2u8; 12]));
        assert!(store.has_attachment("att1").unwrap());

        store.set_attachment_state("att1", "evicted").unwrap();
        let row = store.attachment_meta("att1").unwrap().unwrap();
        assert_eq!(row.state, "evicted");
        let path: Option<String> = store
            .conn
            .query_row("SELECT path FROM attachments WHERE id='att1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(path, None);

        assert!(store.attachment_meta("nope").unwrap().is_none());
    }

    #[test]
    fn conversation_unread_tracks_inbound_after_read_marker() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("vault.db"), &[12u8; 32]).unwrap();
        store.upsert_relay("r1", "https://r.example", "fp", &[1u8; 32]).unwrap();
        store.ensure_conversation("c1", "dm", "r1").unwrap();
        let msg = |id: &str, ts: i64, sender: &str| ImportMessage {
            id: id.into(),
            conversation_id: "c1".into(),
            channel_id: None,
            sender_contact_id: Some(sender.into()),
            relay_ts: ts,
            content: Some("x".into()),
            kind: "text".into(),
            reply_ref_json: None,
            attachments_json: None,
            edited_at: None,
        };
        store
            .import_messages(vec![
                msg("m1", 10, "friend"),
                msg("m2", 20, "self"), // my own message never counts as unread
                msg("m3", 30, "friend"),
            ])
            .unwrap();
        assert_eq!(store.conversation_unread("c1").unwrap(), 2); // m1 + m3

        store.mark_conversation_read("c1").unwrap();
        assert_eq!(store.conversation_unread("c1").unwrap(), 0);

        // A newer inbound message becomes unread again.
        store.import_messages(vec![msg("m4", 40, "friend")]).unwrap();
        assert_eq!(store.conversation_unread("c1").unwrap(), 1);
    }

    #[test]
    fn reactions_add_dedup_remove_and_list() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("vault.db"), &[13u8; 32]).unwrap();
        store.upsert_relay("r1", "u", "fp", &[1u8; 32]).unwrap();
        store.ensure_conversation("c1", "dm", "r1").unwrap();
        store
            .import_messages(vec![ImportMessage {
                id: "m1".into(),
                conversation_id: "c1".into(),
                channel_id: None,
                sender_contact_id: Some("self".into()),
                relay_ts: 1,
                content: Some("hi".into()),
                kind: "text".into(),
                reply_ref_json: None,
                attachments_json: None,
                edited_at: None,
            }])
            .unwrap();

        store.add_reaction("m1", "self", "👍").unwrap();
        store.add_reaction("m1", "self", "👍").unwrap(); // idempotent
        store.add_reaction("m1", "friend", "👍").unwrap();
        assert_eq!(store.conversation_reactions("c1").unwrap().len(), 2);

        store.remove_reaction("m1", "self", "👍").unwrap();
        let rows = store.conversation_reactions("c1").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].reactor_id, "friend");
        assert_eq!(rows[0].emoji, "👍");
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

    #[test]
    fn friend_addressing_lifecycle() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("vault.db"), &[11u8; 32]).unwrap();
        store
            .upsert_relay("r1", "https://relay.example", "fp", &[9u8; 32])
            .unwrap();

        // Not a friend yet.
        assert!(store.friend_addressing("c1", "r1").unwrap().is_none());
        assert!(store.list_friends("r1").unwrap().is_empty());

        let rec = |token: &str, name: Option<&str>| FriendRecord {
            contact_id: "c1".into(),
            display_name: name.map(str::to_string),
            relay_id: "r1".into(),
            handle: "Alice#0001".into(),
            identity_pub: vec![1u8; 32],
            sealing_pub: vec![2u8; 32],
            delivery_token: token.into(),
        };
        store.record_friend(&rec("deliv-a", Some("Alice"))).unwrap();

        let a = store.friend_addressing("c1", "r1").unwrap().expect("friend addressing");
        assert_eq!(a.handle, "Alice#0001");
        assert_eq!(a.sealing_pub, vec![2u8; 32]);
        assert_eq!(a.delivery_token, "deliv-a");

        // Re-record refreshes (e.g. a rotated delivery token) without dropping name.
        store.record_friend(&rec("deliv-a2", None)).unwrap();
        let a2 = store.friend_addressing("c1", "r1").unwrap().unwrap();
        assert_eq!(a2.delivery_token, "deliv-a2");

        let friends = store.list_friends("r1").unwrap();
        assert_eq!(friends.len(), 1);
        assert_eq!(friends[0].contact_id, "c1");
        assert_eq!(friends[0].display_name.as_deref(), Some("Alice"));

        // Unfriend drops addressing + the friend flag (can no longer reach them).
        store.remove_friend("c1", "r1").unwrap();
        assert!(store.friend_addressing("c1", "r1").unwrap().is_none());
        assert!(store.list_friends("r1").unwrap().is_empty());
    }
}
