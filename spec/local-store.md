# Local store & Rust core (v8 design)

> **Status: v8 design — not yet built.** Phase-1 spec: the on-device data model
> and the webview↔Rust boundary, per roadmap **D2** (SQLite + SQLCipher),
> **D13** (key hierarchy), and the decided crypto placement (keys live in the
> Rust core and never cross IPC). Table/command shapes are design intent;
> finalized at build, when this becomes the as-built reference.

## Architecture: the Rust core is a headless client

The split is by *trust*, not convenience:

- **Rust core** — storage (SQLite/SQLCipher + encrypted attachment files),
  **all crypto** (key custody, seal/unseal, sign/verify, Argon2id — via
  RustCrypto/`*-dalek` crates), and **all relay networking** (HTTP + WS). MK,
  derived keys, SQLCipher key, device key, and relay tokens exist only in Rust
  memory (zeroized on lock) or the OS keychain.
- **Webview (Vue)** — rendering and interaction only. It calls **domain-level
  IPC commands** (`messages.send`, not `crypto.encrypt`) and receives plaintext
  *content* it is displaying anyway — never key material, tokens, or wrapped
  blobs. A fully compromised webview can read what's on screen and request
  operations while unlocked, but cannot exfiltrate keys or history wholesale
  (commands are scoped; no `dump-all` surface).

One account per OS user profile (multi-account is post-v8).

## SQLite schema (sketch)

SQLCipher whole-DB; decrypted content in rows so **FTS5 search** works (D2).
`PRAGMA user_version` drives migrations.

```sql
relays(id, url, name, nickname, identity_fp, our_identity_pub, status, joined_at)
contacts(id, display_name, avatar_ref, verification_state,  -- keyed on identity, not handle (UI-1)
         profile_key_epoch, is_friend, blocked_hidden)
contact_relays(contact_id, relay_id, handle, identity_pub, via_attestation)  -- D4c multipath
conversations(id, type,             -- dm | group
              relay_id, group_state_json, group_state_version)  -- D14 cache
messages(id TEXT PRIMARY KEY,       -- sender-assigned (D11)
         conversation_id, channel_id, sender_contact_id,
         relay_ts, content, kind, reply_ref_json, attachments_json,
         deleted, edited_at)
  -- sort key index: (conversation_id, channel_id, relay_ts, sender_contact_id, id)
messages_fts(content)               -- FTS5, external-content table
crdt_docs(id, scope,                -- note | conversation-overlay | settings
          ydoc_state BLOB, state_vector BLOB, compacted_at)
crdt_updates(doc_id, update BLOB, origin, created)   -- pending-compaction log
notes(id, title, doc_id, folder_id, shared_json, created, updated)
notes_fts(title, content)
note_versions(note_id, snapshot BLOB, kind,          -- auto | named (D10)
              name, created)
attachments(id, owner_kind, owner_id, file_key BLOB, -- per-file key (SQLCipher-protected)
            path, thumb BLOB, size, mime, content_hash,
            state)                                   -- present | evicted | expired (D6)
outbox(id, conversation_id, envelope BLOB, relay_id, state, created, attempts)
sync_cursors(relay_id, mailbox_cursor, kt_epoch_seen)
eviction_watermarks(conversation_id, evicted_before_ts, mode)  -- D6 retention
own_devices(device_id, name, platform, added_at, kind)         -- incl. satellites
kt_state(relay_id, own_binding_proof BLOB, last_root BLOB)
settings(key, value)
```

Attachment ciphertext lives on the filesystem (encrypted under its per-file
key); the DB row holds the key + metadata. Message rows are the plain
append-only log ordered by the D11 tuple; mutable overlays (edits, reactions,
read state) live in the per-conversation `crdt_docs` entry and are *projected*
onto message rows for display.

## IPC command surface (sketch)

Namespaced Tauri commands; events flow back to the UI (`message-received`,
`sync-state`, `key-alarm`, …).

- `vault.unlock(method) / lock() / status()` — biometric/keychain, password,
  recovery code (D3); unlock loads SQLCipher key + MK into Rust memory.
- `relays.add(url, invite) / list() / remove()` — D4b join + identity derive.
- `contacts.invite() / redeem(token) / verifySas(contactId) / link(contactId, relayId)` (D4c)
- `messages.send(convId, content, attachments?) / list(convId, cursor) / edit / delete / react / markRead`
- `conversation_activity()` — every conversation's newest-message stamp +
  unread count in one pass (what the side rail orders chats by; conversations
  with no messages report `last_ts` 0 and still list).
- `notes.create / open(id) → doc handle / applyUpdate / history(id) / restore`
- `groups.create / updateState(record)` — signs with owner/admin key (D14).
- `attachments.fetch(id) / evict / rehydrate` (D6 retention)
- `devices.pair() → QR payload / approve(sas) / list / revoke(deviceId)` — revoke
  runs the D13a tier-1 rotation fan-out.
- `backup.export(path, opts) / restore(path)` (below)
- `search.query(text, scope)` — FTS5, never leaves the core.
- `satellite.approve(qr) / unlink(id)` (D12)

## Backup export format (D8)

Single file, `*.accordbackup`:

```
header (plaintext):  magic ∥ formatVersion ∥ kdf=argon2id{m,t,p,salt} ∥ cipher=XChaCha20-Poly1305
body   (encrypted):  zstd(tar{ db-snapshot.sqlite, blobs/<attachment files>, manifest.json })
```

- Key = Argon2id(**recovery code** by default, or a user-chosen passphrase —
  chosen at export time, stated in the manifest).
- **"Include media"** is an export-time toggle (media can dominate size);
  without it, restored attachments enter state `evicted` (re-hydratable, D6).
- Restore = decrypt → verify `formatVersion` → import as a **point-in-time
  snapshot**, then delta-sync from other devices/relays if any exist.
- Manifest records app version, schema `user_version`, account identity fp,
  export time — restore refuses a *newer* schema than the app understands.

## Versioning (local side)

- **DB schema:** `PRAGMA user_version` + forward-only migrations shipped in the
  Rust core; the core refuses to open a DB *newer* than itself ("update the
  app").
- **CRDT payloads:** every relayed Yjs update is wrapped
  `{docSchema, update}`; a client seeing a newer `docSchema` than it supports
  buffers the update and surfaces "update required" rather than corrupting the
  doc. (Envelope versioning is the relay-side half — see
  [relay.md](relay.md).)

## Retention & eviction mechanics (D6)

Eviction rewrites `attachments.state = evicted` + deletes the file, and (mode
c) deletes message rows older than the watermark; `eviction_watermarks` is
consulted by the sync engine so replicated history older than the watermark is
**not** re-fetched. Rehydration requests the blob from own devices first, then
the sender (within relay TTL); permanent failure → `expired`.
