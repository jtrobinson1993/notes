# Local store & Rust core (v8)

> **Status: as built.** The on-device data model and the webview↔Rust boundary.
> The shell that hosts this core is described in
> [native-app.md](native-app.md); the wire side in [relay.md](relay.md).
>
> This is the **only** storage path in the product. The browser client that once
> cached notes in IndexedDB is deleted, along with `lib/idb.ts` and the service
> worker — there is no second store to keep in step, no browser fallback, and
> nothing durable outside the vault. A future web client would need its own
> engine, which is exactly why it is deferred
> ([roadmap.md](roadmap.md#d16--a-v8-web-client-deferred)).

## Architecture: the Rust core is a headless client

The split is by *trust*, not convenience:

- **Rust core** — storage (SQLite/SQLCipher + encrypted attachment files),
  **all crypto** (key custody, seal/unseal, sign/verify, Argon2id — via
  RustCrypto/`*-dalek` crates), and **all relay networking** (HTTP + WS). MK,
  derived keys, SQLCipher key, device key, and relay tokens exist only in Rust
  memory (zeroized on lock) or the OS keychain.
- **Webview (Vue)** — rendering and interaction only. It calls **domain-level
  IPC commands** (`relay_send`, not `crypto.encrypt`) and receives plaintext
  *content* it is displaying anyway — never key material, tokens, or wrapped
  blobs. A fully compromised webview can read what's on screen and request
  operations while unlocked, but cannot exfiltrate keys or history wholesale
  (commands are scoped; there is no `dump-all` surface).

**At rest: SQLCipher whole-DB, composed with the unchanged E2E content
encryption.** The store holds **usable (decrypted) rows** so local
**FTS5 search** works, while the whole file — rows, indexes, *metadata* — is
encrypted by SQLCipher under a random key held in the OS keychain. Field-level
ciphertext was rejected because it leaves DB metadata in cleartext and kills
local search. E2E content keys are separate and mandatory regardless: they
protect data in the relay mailbox and in transit; SQLCipher only adds
device-at-rest protection of the local file.

**Multi-account:** each account gets its **own vault in its own data directory**
(separate MK, device key, store, relay identity), tracked by an `accounts.json`
registry — see [native-app.md](native-app.md#multi-account).

## SQLite schema (as built)

`PRAGMA user_version` drives forward-only migrations in `store.rs`; the core
refuses to open a DB newer than itself. **11 migrations** are applied today.

```sql
-- v1: the core table set
relays(id, url, name, nickname, identity_fp, our_identity_pub, status, joined_at)
contacts(id, display_name, avatar_ref, verification_state,  -- keyed on identity, not handle
         profile_key_epoch, is_friend, blocked_hidden)
contact_relays(contact_id, relay_id, handle, identity_pub, via_attestation)
conversations(id, type,                     -- dm | group
              relay_id, group_state_json, group_state_version)
messages(id TEXT PRIMARY KEY,               -- sender-assigned, relay-independent
         conversation_id, channel_id, sender_contact_id,
         relay_ts, content, kind, reply_ref_json, attachments_json,
         deleted, edited_at)
  INDEX idx_messages_sort(conversation_id, channel_id, relay_ts, sender_contact_id, id)
crdt_docs(id, scope, ydoc_state, state_vector, compacted_at)
crdt_updates(doc_id, seq, update_blob, origin, created)
notes(id, title, doc_id, folder_id, shared_json, created, updated)
note_versions(note_id, seq, snapshot, kind, name, created)
attachments(id, owner_kind, owner_id, file_key, path, thumb,
            size, mime, content_hash, state)   -- present | evicted | expired
outbox(id, conversation_id, envelope, relay_id, state, created, attempts)
sync_cursors(relay_id, mailbox_cursor, kt_epoch_seen)
eviction_watermarks(conversation_id, evicted_before_ts, mode)
own_devices(device_id, name, platform, added_at, kind)
kt_state(relay_id, own_binding_proof, last_root)
settings(key, value)

-- v2  FTS5: messages_fts + notes_fts (external-content + sync triggers);
--     notes.search_text = the plaintext projection of the Yjs doc, written on save
-- v3  attachments.iv          (legacy AES-GCM refs carry an external IV)
-- v4  notes.note_key          (own notes unwrapped from MK; shared notes unsealed)
-- v5  UNIQUE(note_versions.note_id, kind, created)   -- idempotent re-import
-- v6  notes.tags_json         (tags as first-class metadata, not just search text)
-- v7  contact_relays.sealing_pub + .delivery_token   -- friend addressing
-- v8  conversations.last_read_ts                     -- local unread tracking
-- v9  message_reactions(message_id, reactor_id, emoji, created_at)
-- v10 groups(group_id, group_key, name, created_at)  -- local group key material
-- v11 kt_state.last_epoch + kt_roots_seen(relay_id, epoch, root_hash, first_seen)
```

Attachment ciphertext lives on the filesystem under `dataDir/blobs` (two-level
sharded paths, atomic tmp+rename writes, id charset guard against path
traversal); the DB row holds the per-file key + metadata. Message rows are the
plain append-only log ordered by the sort tuple below; reactions live in
`message_reactions`.

**FTS5 availability was a build risk** (the vendored SQLCipher bundle had to
support it) and is covered by a dedicated gate test.

One column is schema ahead of behaviour and should not be read as a feature:
`notes.shared_json` is only ever populated by `Store::import_notes` — the
legacy-migration path, which is **no longer reachable** (it is registered as no
IPC command, since the app it migrated from is deleted) — so in a running v8
install every note is unshared. Note sharing itself is unbuilt; see
[roadmap.md](roadmap.md#notes-under-v8).

## IPC command surface

**79 Tauri commands**, all registered in `lib.rs`; events flow back to the UI
(`relay:message`, `kt:alarm`, …). `web/src/lib/native.ts` is the typed wrapper,
and it is the app's *entire* I/O surface — every read, write and network call
the UI makes goes through this table.

| Area | Commands |
|---|---|
| Accounts | `account_list` `account_add` `account_switch` `account_set_label` |
| Vault | `vault_status` `vault_create` `vault_unlock` `vault_unlock_keychain` `vault_unlock_recovery` `vault_restore_from_escrow` `vault_lock` `settings_get` `settings_set` |
| Relay | `relay_connect` `relay_register` `relay_register_friend_accept` `relay_status` `relay_escrow_upload` `relay_change_handle` `relay_directory_publish` `relay_register_verifier` `relay_my_directory_keys` `device_public_key` |
| Friends | `relay_invite_mint` `relay_invite_redeem` `friends_list` `friend_addressing` `friend_remove` |
| Messaging | `relay_send` `relay_send_message` `relay_edit_message` `relay_delete_message` `relay_react` `relay_mailbox_fetch` `relay_mailbox_ack` `relay_mailbox_drain` `envelope_seal` `envelope_open` |
| Conversations | `dm_conversation_id_for` `dm_mark_read` `dm_unread` `conversation_activity` `conversation_reactions` `messages_page` `messages_ingest` `message_edit` `message_delete` |
| Groups | `group_create` `group_add_member` `group_list` `relay_send_group_message` `relay_group_edit_message` `relay_group_delete_message` `relay_group_react` |
| Notes | `notes_list` `notes_load_all` `note_get` `note_create` `note_save` `note_delete` `notes_search` |
| Attachments | `attachment_upload` `attachment_fetch` `attachment_put` `attachment_get` `attachment_has` `attachment_evict` |
| Voice | `relay_call_offer` `voice_join` `voice_signal` `voice_leave` `sfu_join` `sfu_transport` `sfu_connect` `sfu_produce` `sfu_consume` `sfu_leave` |
| Key transparency | `kt_self_audit` `kt_gossip_send` |

`conversation_activity` returns every conversation's newest-message stamp +
unread count in one pass — what the side rail orders chats by; conversations
with no messages report `last_ts` 0 and still list.

## Message ordering (no server counter)

The retired legacy server assigned a dense per-conversation `seq`; the relay that
replaced it does not, and cannot. A zero-at-rest relay can't own a durable
counter, and multipath delivery means no single relay even sees every message.
So:

- **Sort key = `(relayTimestamp, senderId, messageId)`.** The relay stamps each
  message at arrival (stateless); the tuple tiebreak makes same-millisecond
  collisions deterministic.
- **No dense integer `seq` is ever derived.** Devices hold different subsets of
  a conversation (history floors, local eviction, mid-history pairing), so any
  local "sort and number" diverges across devices. Positions are never
  materialized — only the sort key.
- **Anchors are message ids, not positions.** Replies, edits and reactions
  reference the sender-assigned message id; `ReplyRef` embeds a snapshot
  `{id, timestamp, sender, preview}` so every client renders the same anchor
  even if the original is missing or evicted. Read state = max `(timestamp, id)`
  seen — a monotonic max register.
- **Mixed relay clocks are tolerated.** Under failover one thread can carry
  stamps from two relays with clock skew; fine for display order (seconds, not
  hours), and duplicates dedupe by message id. Nothing may assume one global
  clock.
- Offline-composed sends are stamped **at upload**, not compose time (Signal
  behaves the same); the local echo orders provisionally until the ack returns
  the stamp.

**Threat-model note:** the relay is trusted for *order* — it could reorder or
backdate stamps. Impact is low (content is authenticated, replies snapshot their
context, and a relay can already withhold or delay delivery), but it is a real
trust boundary — see [security.md](security.md).

## CRDTs & mutable state

**Yjs** is the CRDT, chosen for its official `y-codemirror.next` binding (the
app is CodeMirror 6), large-text performance, and the Matrix-proven pattern of
relaying encrypted binary updates opaquely. Local persistence goes through the
Rust core, *not* `y-indexeddb` — there is no IndexedDB in the product at all.

What is built today is the **doc lineage, not collaborative editing**:
`lib/nativeNotes.ts` keeps one `Y.Doc` per note in the webview, applies a body
edit as a coarse delete+insert inside one transaction, and hands
`Y.encodeStateAsUpdate(doc)` to `note_save`, which stores it in
`crdt_docs.ydoc_state`. The `y-codemirror.next` binding is **not wired up** (the
package isn't even a dependency yet) and nothing writes `crdt_updates` — the
incremental-update table is schema laid down ahead of the sync engine. Real
concurrent editing and update relay are unbuilt; see
[roadmap.md](roadmap.md#notes-under-v8).

The append-only message log stays **outside** Yjs (plain SQLite rows). Mutable
overlays map as:

| State | Model |
|---|---|
| Edits | **LWW register** — single-author, so last-write-by-logical-clock wins |
| Reactions | **add-wins set** — the one place genuine multi-user concurrency happens |
| Read state | **monotonic max register** — only moves forward; merge = max |
| Deletion | **delete-for-everyone only**, via a propagating tombstone (delete-wins) |
| Typing / presence | **ephemeral** — never persisted, not CRDT |

There is no "delete for me". The tombstone replicates to all participants and
devices, each removes the content, and content is garbage-collected after
convergence — the tombstone is what makes a delete stick despite offline
replicas, which would otherwise resurrect the message on re-sync. It renders as
a "message deleted" placeholder.

Caveat worth stating plainly: CRDT convergence is *conflict-free*, not
*semantically perfect* — two people editing the same sentence offline merge into
a deterministic but possibly awkward result. Acceptable for notes.

## Backfill integrity

A new joiner's history is served from **members' devices**, not the relay, so
backfill must be tamper-evident: every message is **individually signed by its
sender's identity key** over `{message id, conversation, content}` inside the E2E
envelope. A member serving history therefore cannot forge or alter what someone
else said; the joiner verifies each signature against the directory / KT log.

Residual, documented: a serving member can **omit** messages (selective history)
— not fully preventable, mitigated by preferring the owner's or multiple devices
as backfill sources. The relay arrival timestamp sits outside the signature, so
backfill *order* is only as trustworthy as the relay stamp.

## Attachments on device

Each attachment gets a fresh **random per-file key**; only the **ciphertext**
leaves the device, while the per-file key + metadata (name, size, mime) ride
*inside* the E2E message under the conversation/group key — never to the relay.

**The relay is not a durable store.** It deletes a blob once every recipient
acks it, and on TTL regardless, so media fetched only over the network would
become permanently unavailable — including for the *sender*, who would lose the
ability to open what they sent. Both transfer paths therefore keep a local copy:

- `attachment_upload` encrypts, uploads, and **caches the ciphertext locally**.
- `attachment_fetch` **reads the local store first** — a cached attachment
  decrypts with no network at all, so old media keeps working offline — and
  anything it does pull from the relay is persisted on the way through, so it is
  downloaded once.

What is stored is the **ciphertext exactly as it travels**, under the same
per-file key, so the filesystem never holds plaintext; the key sits in the
SQLCipher-protected row. Caching is **best-effort**: the transfer has already
succeeded by the time it runs, so a cache failure logs and is ignored rather
than failing a send or a view. Fetched bytes are **decrypted before being
cached**, so a blob that doesn't authenticate under the message's ref can't
overwrite a good row.

Two states are kept honest deliberately: re-fetching an **evicted** attachment
restores its row to `present` with the new path (a plain insert-or-ignore would
leave it stuck evicted with a NULL path), and a row claiming `present` whose
file has vanished is **corrected to `evicted`** on the failed read rather than
lying about what the device holds.

**Note attachments never leave the device at all.** Notes are local-only (there
is no note sync yet), so a note's attachment has no relay copy to
upload to or fetch from: `putNoteAttachment` writes the ciphertext straight into
the vault via `attachment_put` (`owner_kind = 'note'`, minting its own
base64url id since no relay is there to assign one), and
`getNoteAttachmentCiphertext` reads it back via `attachment_get`. There is no
other path: the legacy server endpoints these helpers used to fall through to in
a browser are gone, so `lib/attachments.ts` now talks only to the Rust core.
Because there is no remote copy, an evicted note attachment is **terminal** — it
renders as missing rather than retrying a fetch that cannot succeed.

`attachment_evict` is the local, per-device reclamation path (state `evicted`,
file removed, row kept) — distinct from delete-for-everyone. Nothing calls it
automatically yet; the retention policy that would is in
[roadmap.md](roadmap.md#local-retention--the-storage-screen).

## Retention & eviction

Local, per-device space reclamation — **distinct from delete-for-everyone**,
which tombstones globally; this deletes on *your* device only and affects no one
else. Eviction rewrites `attachments.state = evicted` and deletes the file, and
(in the most aggressive mode) deletes message rows older than the watermark;
`eviction_watermarks` is consulted by the sync engine so history older than the
watermark is **not** re-fetched. Rehydration requests the blob from your own
devices first, then the sender within relay TTL; permanent failure → `expired`.

The **retention policy is opt-in and off by default** — never silently delete
user data. Three modes are specified: downscale old media; evict old media but
keep messages; evict everything past N days. The policy engine, the Storage
screen, and rehydration-from-own-devices are **not built yet** — see
[roadmap.md](roadmap.md).

## Backup export format (not built)

The `.accordbackup` container is specified but unimplemented — see
[roadmap.md](roadmap.md#offline-encrypted-backup-export-d8).

## Versioning (local side)

- **DB schema:** `PRAGMA user_version` + forward-only migrations shipped in the
  Rust core; the core refuses to open a DB *newer* than itself ("update the
  app").
- **CRDT payloads:** every relayed Yjs update is wrapped `{docSchema, update}`;
  a client seeing a newer `docSchema` than it supports buffers the update and
  surfaces "update required" rather than corrupting the doc. (Envelope
  versioning is the relay-side half — see [relay.md](relay.md).)
