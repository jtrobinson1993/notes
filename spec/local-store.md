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
refuses to open a DB newer than itself. **13 migrations** are applied today.

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
-- v12 emote_cache(id, name, file_key, iv, path, mime, width, height, animated,
--                 bytes, last_used_at, state)      -- present | evicted
--     + INDEX idx_emote_cache_lru(state, last_used_at)
-- v13 contact_relays.kt_verified_epoch + .kt_verified_at
--     -- the relay epoch of the SIGNED KT root whose inclusion proof bound this
--     -- contact's handle to the identity_pub in this row. NULL = never proven,
--     -- and it is cleared whenever identity_pub changes (a re-keyed contact is
--     -- unverified until the new key is proven). See key-transparency.md.
--     -- The relay's VRF public key is pinned alongside, in settings under
--     -- `kt.vrfPub.<relayFp>` (no migration — it is a plain setting).
--     -- So is the relay identity pin itself: `relay.identity.<baseUrl>` holds
--     -- JSON `{ fp, identity_pub, delegation_version, delegation_online_key }`
--     -- — the pinned offline ROOT plus the anti-rollback high-water mark for
--     -- its delegation chain. `delegation_version` only ever increases (a
--     -- superseded delegation stays validly signed forever, so replaying one is
--     -- how a revoked online key gets trusted again). Settings, not a table,
--     -- deliberately: it is per-account state with no relational shape, and it
--     -- lives inside the encrypted vault. See relay.md § Pinning the relay
--     -- identity.
-- v14 TRIGGER groups_key_is_immutable  -- BEFORE UPDATE OF group_key, ABORT on
--     -- a change. A group key is write-once: `insert_group` is INSERT-only and
--     -- the schema enforces the same thing, so a future accessor cannot
--     -- reintroduce the re-key hole an inbound group-invite used to exploit
--     -- (chat.md § Who may hand me a group key). Real rotation, when it lands,
--     -- must replace this trigger with one gated on the signed group-state
--     -- record — not quietly drop it.
```

Attachment ciphertext lives on the filesystem under `dataDir/blobs` (two-level
sharded paths, atomic tmp+rename writes, id charset guard against path
traversal); the DB row holds the per-file key + metadata. Emote ciphertext uses
the *same* `BlobStore` type under a **separate root**, `dataDir/emotes` — both
are addressed by an id that arrives over the wire, and one shared namespace
would let a relay-assigned blob id collide with a 7TV emote id and clobber the
other's bytes (emote files are additionally named by a blinded hash, not the id;
see below). Message rows are the plain append-only log ordered by the sort tuple
below; reactions live in `message_reactions`.

**FTS5 availability was a build risk** (the vendored SQLCipher bundle had to
support it) and is covered by a dedicated gate test.

One column is schema ahead of behaviour and should not be read as a feature:
`notes.shared_json` is only ever populated by `Store::import_notes` — the
legacy-migration path, which is **no longer reachable** (it is registered as no
IPC command, since the app it migrated from is deleted) — so in a running v8
install every note is unshared. Note sharing itself is unbuilt; see
[roadmap.md](roadmap.md#notes-under-v8).

## IPC command surface

**81 Tauri commands**, all registered in `lib.rs`; events flow back to the UI
(`relay:message`, `kt:alarm`, …). `web/src/lib/native.ts` is the typed wrapper,
and it is the app's *entire* I/O surface — every read, write and network call
the UI makes goes through this table.

| Area | Commands |
|---|---|
| Accounts | `account_list` `account_add` `account_switch` `account_set_label` |
| Vault | `vault_status` `vault_create` `vault_unlock` `vault_unlock_keychain` `vault_unlock_recovery` `vault_lock` `settings_get` `settings_set` |
| Relay | `relay_connect` `relay_register` `relay_register_friend_accept` `relay_status` `relay_change_handle` `relay_directory_publish` `relay_register_verifier` `relay_my_directory_keys` `device_public_key` |
| Friends | `relay_invite_mint` `relay_invite_redeem` `friends_list` `friend_addressing` `friend_remove` |
| Messaging | `relay_send` `relay_send_message` `relay_edit_message` `relay_delete_message` `relay_react` `relay_mailbox_fetch` `relay_mailbox_ack` `relay_mailbox_drain` `envelope_seal` `envelope_open` |
| Conversations | `dm_conversation_id_for` `dm_mark_read` `dm_unread` `conversation_activity` `conversation_reactions` `messages_page` `messages_ingest` `message_edit` `message_delete` |
| Groups | `group_create` `group_add_member` `group_list` `relay_send_group_message` `relay_group_edit_message` `relay_group_delete_message` `relay_group_react` |
| Notes | `notes_list` `notes_load_all` `note_get` `note_create` `note_save` `note_delete` `notes_search` |
| Attachments | `attachment_upload` `attachment_fetch` `attachment_put` `attachment_get` `attachment_has` `attachment_evict` |
| Emoji | `emote_search` `emote_get` `emote_cache_put` `emote_cached_list` |
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

## Emoji on device (the used-emoji cache)

Emote *search* is live and network-bound, but an emoji you have **already been
sent** must render offline and without a round-trip. `emoji.rs` + the
`emote_cache` table are that store. It is deliberately the **same shape as the
attachment cache** rather than a second design: metadata row in SQLCipher,
opaque ciphertext in a `BlobStore`, an `evicted` state that behaves exactly like
a miss, and an **upsert** (not insert-or-ignore) on the re-cache path — the bug
`upsert_attachment` exists to avoid, where a re-fetched entry stays stuck
`evicted` with a NULL path forever.

**Only emotes encountered in content are cached.** Search results are browsing,
not content: the picker renders them straight from the relay's capability URL
and nothing is written. Caching them would let one picker session fill the
budget with emotes nobody ever sent.

**Encrypted at rest, like everything else.** Attachment ciphertext already
exists (it is what travels), but an emote image arrives as plaintext WebP from
the relay. The *set of emotes you hold* is a fingerprint of what you have been
sent, so each image is encrypted with a fresh random per-file key under the same
AES-256-GCM helper attachments use, with the key in the SQLCipher-protected row.

**Filenames are blinded, because a filename is metadata too.** A 7TV id is a
*public* identifier for a specific emote, so naming blobs by id would let anyone
who can list `dataDir/emotes` read the whole set straight off the directory —
encrypted bytes or not. Files are named `SHA-256(salt ‖ id)` under a random
per-vault salt kept in the (SQLCipher-protected) settings table, so the listing
is opaque without the DB key, and the salt being per-vault means two devices'
directories can't even be compared. This is the one place the emote store is
*stricter* than the attachment store, whose blob ids are opaque relay-assigned
strings rather than public names.

**Size-bounded LRU.** `emote_cache.bytes` is the ciphertext length on disk, and
every insert evicts least-recently-used `present` rows until the total is back
inside the budget. `last_used_at` is touched on every **successful** read — a
row whose bytes are gone or won't decrypt is corrected to `evicted` instead of
floating to the top of the LRU by being asked for repeatedly. Eviction is
invisible beyond a later re-fetch.

The budget defaults to **64 MiB** and is overridable through the ordinary
settings table (`emote_cache_budget_bytes`; a non-numeric or non-positive value
is ignored rather than removing the bound). 64 MiB was picked because 7TV 2x
WebPs run ~10–40 KiB, so it holds roughly 2,000–6,000 distinct emotes — more
than any real history surfaces — while staying bounded in the adversarial
direction: a single image is capped at 1 MiB.

Commands:

- `emote_search(query, page?, limit?)` — proxied 7TV search. Runs in the core
  for the same reason the SFU control calls do: the **device token never crosses
  IPC**. An empty query returns the relay's top emotes (the picker's default
  set).
- `emote_get(id, name)` — cache first, relay on a miss; the fetched bytes are
  cached on the way through. Returns `fetched: true` when it went to the
  network, which is what a caller's per-message fetch cap counts.
- `emote_cache_put(meta, bytes)` — persist bytes the caller already holds.
- `emote_cached_list()` — the offline picker's set, most recently used first.
  Key-free by construction: `EmoteRow` (which carries the per-file key) is not
  `Serialize`.

Hardening that is load-bearing, not incidental:

- **Ids and names are validated in the core** — 26-char Crockford ULID and
  `[A-Za-z0-9_]{2,40}` — before they become filenames or URL path segments.
- **The relay does not get to choose the image origin.** A search result's `url`
  is only accepted as a site-relative `/api/relay/emote/<sig>/<id>.webp` for the
  emote being described, and is then joined onto the pinned relay base. A
  hostile or compromised relay handing back a third-party CDN link would
  re-create exactly the IP leak the proxy exists to prevent.
- **The 1 MiB image cap is enforced client-side too**, against the *streamed*
  body rather than a declared `content-length`, and the response must be
  `image/*`. The relay's own cap is not trusted with this device's disk.

One accepted, low-severity limitation: `emote_get(id, name)` takes the shortcode
from message content, so a **sender chooses the name a cached emote is filed
under**, and a later message can rename an entry already in your offline picker
(latest observation wins). It is cosmetic and device-local — the id, and so the
image, is unaffected — but it is a sender-controlled field and is recorded here
rather than discovered later. If it ever matters, the fix is to prefer the name
the relay's search returned over one seen in content.

**Who may write to this cache, and when.** Exactly one client path does:
`EmojiText.vue`, the shared renderer, via `lib/emoji/render.ts`. An emote is
persisted precisely when it is *displayed as content* — never when it is merely
browsed in the picker, which renders search results straight from the relay's
capability URLs and calls nothing here. The client also enforces the piece the
core structurally cannot: a **cap of 20 distinct network-fetched emotes per
message**, keyed by message id so re-rendering cannot bypass it, with the
remainder rendered as literal `:shortcode:` text. `emote_get`'s `fetched` flag
is what that budget counts, so cache hits stay free and unlimited. The rationale
and the rest of the client policy are in
[chat.md](chat.md#emoji-emotes-the-picker-and-the-cap).

The offline picker reads this cache too (`emote_cached_list`, then `emote_get`
per tile). That is a *read* path by construction: its input is what the core
already holds, so it cannot pull anything new in.

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
