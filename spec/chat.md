# Chat (v8) — native, local-first E2EE messaging

> **Status: as built.** Chat is a native-only surface. The **Rust core**
> (`src-tauri/src/`) holds the keys, seals and opens the envelopes, and owns the
> message log; the webview only renders what the core hands it. The **relay** is
> a store-and-forward queue for opaque envelopes — it is not a chat server.
>
> The legacy browser chat is **gone**, not deprecated: server-mediated
> conversations, conversation keys + membership epochs, per-conversation dense
> `seq`, channels, threads, the `/api/ws` chat socket, server-held friend
> requests and invite codes, and the whole `routes/chat.ts` + `realtime.ts`
> surface were deleted with browser mode. Nothing below describes them.

Related: the wire protocol in [relay.md](relay.md), the on-device schema and
ordering rules in [local-store.md](local-store.md), key derivation and delivery
tokens in [accounts-and-crypto.md](accounts-and-crypto.md), the shell and
sidebar in [ui.md](ui.md), voice in [voice.md](voice.md).

## The shape

A conversation is either a **DM** between two friends or a **group**. Both are
rows in the local `conversations` table and both carry their messages in the
same local `messages` log; the difference is only how a message is sealed (per
recipient vs under a shared group key) and how it is addressed on the relay.

There is no server-side conversation object, no membership table the client
reads back, and no channel model — a v8 group has exactly one room. Every list,
every page of history and every unread count is answered from the **local
encrypted store**, so the UI is instant and works offline; the relay is only how
messages get between devices.

## Friends & invites (D4b) — as built

**Friendship is invite-only, and the invite is a bearer capability.** There is
no "send a friend request to `Word#1234`": handles are not a reach surface at
all, so there is nothing to enumerate. The `friends`/`friend_requests` tables and
the ephemeral server-side invite codes of the legacy product no longer exist.

An invite is a self-describing string built entirely client-side
(`web/src/lib/invites.ts`), `accord://friend?i=<base64url(json)>`, carrying:

```
{ v:1, relayUrl, relayFp, token, handle, identityPub, sealingPub }
```

- `token` is a fresh 256-bit bearer capability. The relay only ever stores
  `sha256(token)` (`POST /api/relay/invites`, device-token authed, TTL capped at
  14 days) — the token itself never reaches it.
- `relayUrl` + `relayFp` let a brand-new user join the inviter's relay without
  choosing a server, and pin its identity.
- `identityPub` + `sealingPub` are the inviter's **per-relay** directory keys,
  carried in the invite so the invitee seals to keys it got from the (in-person)
  invite channel rather than from the relay's directory.

**The handshake** (`nativeInvites.ts` → the core → the drain):

1. The invitee seals a `friend-accept` — `{handle, displayName?, deliveryToken,
   sealingPub}` — to the inviter's `sealingPub` and posts it through
   `POST /api/relay/invites/redeem`. That leg takes **no device token**:
   requiring one would let the relay record "X redeemed Y's invite", which is
   exactly the social-graph edge sealed sender exists to avoid.
2. The inviter's next mailbox drain verifies the envelope, records the sender as
   a friend (contact id = the **verified** sender identity key), and
   **reciprocates** a `friend-confirm` carrying its own handle, display name and
   delivery token.
3. The invitee's drain records that confirm → mutual. Until then the invitee has
   redeemed but has no friend: the accept simply waits in the inviter's queue
   (hold-until-ack), so the handshake completes whenever the inviter next comes
   online. ⚠ The confirm itself is **best-effort and not retried** — the drain
   acks the accept whether or not the reciprocal send succeeded, so a confirm
   that fails to deliver leaves a permanent half-friendship (inviter sees the
   friend, invitee does not) with no recovery but a fresh invite.

A new account can be onboarded by the same invite (`registerViaInvite`): the
token gates signup **and** carries the friend handshake, so the account is
friends with its inviter on its first authenticated call.

**Reach is a capability, not a friendship check.** The relay has no friend
graph to consult. A send is authorized by the recipient's **delivery token**
(`hash(token) == verifier`), which is handed out only by the handshake above —
no token, no delivery. That is how the friends-gate invariant survives the loss
of a server: it is enforced cryptographically rather than by a table lookup. See
[accounts-and-crypto.md](accounts-and-crypto.md#delivery-tokens).

**Unfriend is local only, today.** `friend_remove` clears `is_friend` and drops
the contact's addressing (so *we* can no longer reach *them*), but the delivery
token is one per account, derived from the profile key — so the removed person
keeps a working capability until the profile key is rotated and re-issued to the
remaining friends. That rotation fan-out is **not built**; nor is in-group
blocking. Until it lands, "unfriend" is "hide them and stop being able to reach
them", not "revoke their reach to me". See
[roadmap.md](roadmap.md#revocation--blocking-fan-out).

UI: `FriendsPage.vue` (create an invite, copy it, paste one to redeem, unfriend)
and the add panel in `NativeChat.vue`. Minted invites are listed **in memory for
the session only** — the relay holds only the hash, so there is nothing to fetch
back and nothing to revoke beyond letting it expire.

### Invite carriers

Built: the invite string itself, shared by copy/paste through any channel. The
**QR / universal-link carriers** and the in-app "tappable invite" rendering are
**not built** — see [roadmap.md](roadmap.md). The decided shape for them is that
redemption always runs through the app (never a browser session), with the token
and relay fingerprint in a URL `#fragment` so they are never sent to any server.

### Multi-relay redemption is not built

`relay_invite_redeem` posts to the **connected** relay, so redeeming an invite
minted on a different relay does not work today even though the invite carries
`relayUrl`/`relayFp` (those are used by the register-via-invite onboarding path,
which connects to the invite's relay first). Multi-relay reachability is
roadmap work.

## Conversation identity

- **DM:** `dm:<base64url(sha256(lo‖hi))>` over the two per-relay **identity
  keys**, sorted so both sides derive the same id with no exchange
  (`identity::dm_conversation_id`). This is a security property, not a
  convenience: on ingest the receiver **recomputes** the conversation id from
  `(me, verified sender)` and overwrites whatever the payload claimed, so a
  sender cannot drop a message into a conversation they are not part of.
- **Group:** `grp:<base64url(128 random bits)>`, minted by the creator. The id
  must be unguessable — a genesis state PUT for an unknown id simply creates
  that group (see [relay.md](relay.md#group-state-d14)).

Conversation rows are created lazily (`ensure_conversation`) by the send path,
the drain, and `dm_conversation_id_for`, so a DM exists for every friend by
construction — which is why the rail can list a friend you have never messaged.

## What the relay sees

| Sees | Never sees |
|---|---|
| An opaque envelope, its size, and the arrival timestamp it stamps | Message text, attachments, reactions, emoji, display names |
| Which **device queues** an envelope was copied into (= who the recipients are) | Who **sent** it — DM and group sends carry no device token, only a delivery/group token |
| Group membership, from the group-state record it must read to fan out | The group key, the group's content, or any per-message sender |
| `hash(deliveryToken)`, `hash(inviteToken)` | The tokens themselves |

Sender anonymity is the point of the D6 envelope: the signed sender certificate
lives **inside** the ciphertext. The relay is still trusted for **ordering and
availability** — it can delay, drop, reorder or backdate — which is a real trust
boundary, documented in [security.md](security.md) and
[local-store.md](local-store.md#message-ordering-no-server-counter).

## The envelope (D6/D11)

`src-tauri/src/envelope.rs`. Two wrappings, one inner plaintext.

- **DM envelope** — `{v:1, eph, nonce, ct}`: an ephemeral X25519 sealed box to
  the recipient's sealing key. ECDH → HKDF-SHA256 (salted with the **ephemeral
  public key**, so each envelope's content key is unique even if an ECDH output
  ever repeated) → AES-256-GCM.
- **Group envelope** — `{v:1, nonce, ct}`: encrypted **once** under the shared
  group key and fanned out by the relay to every member, so a group send is one
  upload rather than N. The AES key is HKDF-derived from the group key with a
  distinct info string (`accord/group-envelope/v1`) because the same group key
  also derives the **group token** that authorizes the send — neither is ever
  used raw.
- **Inner plaintext** (identical in both) — `{kind, payload_b64,
  sender_identity_pub, sig, sent_at}`. `sig` is Ed25519 over
  `"accord/envelope-sig/v1|" ‖ kind ‖ "|" ‖ payload`, so the signature is
  domain-separated and covers the kind as well as the bytes. A member serving
  history later therefore cannot forge or alter what someone else said (D11
  backfill integrity).

`open`/`open_group` verify the signature before returning; a caller only ever
sees an `Opened` whose `sender_identity_pub` is authenticated. An unknown outer
`v` is surfaced as `UnknownVersion` rather than an error the caller can confuse
with tampering — the drain buffers those (below).

## The sealed message payload (v1)

`src-tauri/src/message.rs`. A chat message rides in a `kind = "msg"` envelope:

```
{ v:1, id, conversation_id, channel_id?, sent_at, kind, content?,
  reply_ref_json?, attachments_json? }
```

snake_case JSON: like the sibling sealed `Inner`, this is encoded and decoded
only in the Rust core and never crosses the IPC/HTTP boundary, so it does not
follow the camelCase API convention.

Two fields are **deliberately absent**, because trusting them would be a
vulnerability:

- **No sender field.** The sender is the signed certificate inside the
  ciphertext; the drain stamps `sender_contact_id` from the *verified*
  `sender_identity_pub`. (Interim: the identity key itself is the contact id.)
- **No ordering field.** `sent_at` is a display hint only. The ordering key is
  the relay's delivery stamp, applied by the receiver on drain.

`id` is sender-assigned (128 random bits, base64url) and globally unique: it is
the idempotency key for ingest, the dedup key across at-least-once delivery, and
the anchor edits/deletes/reactions target. `kind` is the *message* kind
(`text` today) — distinct from the *envelope* kind.

`channel_id` is carried and stored but always `None` in v8: groups have no
sub-channels. `reply_ref_json` is likewise a reserved column with no producer —
replies are **not built** (see [Not built](#not-built)).

## Ordering — `(relayTimestamp, senderId, messageId)`, no dense seq

The legacy server assigned a dense per-conversation `seq`. A zero-at-rest relay
cannot own a durable counter, and no single relay sees every message, so the
sort key is the tuple **`(relay_ts, sender_contact_id, id)`** — the relay's
arrival stamp, tie-broken deterministically. `idx_messages_sort` indexes exactly
that, and **no dense integer position is ever derived**: devices hold different
subsets of a conversation (eviction, mid-history pairing), so any local "sort and
number" would diverge between them. The rationale and the mixed-relay-clock
consequences live in
[local-store.md](local-store.md#message-ordering-no-server-counter).

History paging is `messages_page(conversation_id, channel_id, before, limit)`,
newest-first, with the cursor taken from the oldest row of the previous page
(`nativeChat.ts` keeps per-channel cursors and an `exhausted` flag, reset on a
fresh open). ⚠ The paging cursor compares `(relay_ts, id)` while the query orders
by `(relay_ts, sender_contact_id, id)`; the two only agree when no two messages
share a millisecond, so a same-millisecond tie can drop or repeat a row across a
page boundary. Cheap to fix by carrying the sender in the cursor.

The sender's own copy is **teed** into the log at send time with
`sender_contact_id = 'self'` and the `relay_ts` the relay returned, so the
message renders immediately and orders correctly; the sender's fanned-out copy
(groups) dedups against it by `id`.

## Mutable state — the CRDT overlays

The message log is append-only and stays outside Yjs. Everything mutable about a
message is a separate small envelope of its own kind, applied to the row:

| State | Model | Envelope kind | Payload | Authority |
|---|---|---|---|---|
| Edit | LWW register (single-author) | `edit` | `{id, content, editedAt}` | applied **only** if the verified sender equals the target's recorded author |
| Delete | tombstone, delete-wins, for everyone | `delete` | `{id}` | same author check |
| Reaction | add-wins set | `react` | `{id, emoji, op:"add"\|"remove"}` | any sender who can see the message; the reactor is the verified sender |
| Read state | monotonic max register | — | — | local only; never leaves the device |

- **Edits/deletes are author-gated at ingest, not at the relay.** The drain looks
  up `message_sender(target)` and applies nothing unless it matches the verified
  envelope sender, so a group member cannot delete or rewrite someone else's
  message. A delete nulls `content` and sets `deleted = 1`; the row stays as the
  "Message deleted" placeholder — there is no "delete for me", and the tombstone
  is what stops an offline replica resurrecting the message on re-sync.
- **"Last write" is arrival order, not a logical clock.** `message_apply_edit`
  overwrites `content` and stamps `edited_at` from the payload without comparing
  it to the stored one, so two edits from the same author converge on whichever
  the relay delivered last. Single-author edits make that adequate today; it is
  not a true LWW register and should not be treated as one if edits ever gain a
  second writer. The UI renders `edited_at` as a muted "(edited)" marker.
- **An edit/delete for a message we have never seen is dropped**, not queued:
  FIFO delivery puts the send before its own edit, and holding unresolvable
  mutations would need a second queue with its own expiry.
- **Reactions** are rows in `message_reactions(message_id, reactor_id, emoji)`,
  idempotent by that triple, `reactor_id = 'self'` for mine. They are ordinary
  sealed envelopes, so the relay learns nothing about who reacted or with what —
  unlike the legacy server, which stored (encrypted) reaction rows and knew the
  shape of the graph.
- **Read state never leaves the device.** `conversations.last_read_ts` advances
  to the newest message's `relay_ts` on open (`dm_mark_read`), and unread is
  "inbound, not deleted, newer than the marker". No read receipts are sent —
  there is no wire format for one, and adding one would put per-message timing
  metadata on the relay.

## Inbound: the mailbox drain

`relay_mailbox_drain` (`lib.rs`), triggered by the content-free `relay:mail`
live nudge, on reconnect, and on unlock; idempotent and safe to call
concurrently (`nativeRelay.ts` single-flights and coalesces it).

Per queued row: **open → verify → decode → apply → ack**. A DM open is tried
first; on failure each of my group keys is tried, and the key that opens it
identifies the group (so the group conversation id comes from the key, never
from the payload).

`message::disposition` is a pure function over the open result, so the whole
policy is unit-tested with no network or live crypto. Kinds handled:
`msg`, `edit`, `delete`, `react`, `friend-accept`, `friend-confirm`,
`group-invite`, `call-offer` ([voice.md](voice.md)), `kt-gossip`
([key-transparency.md](key-transparency.md)).

**Ack policy is security-shaped:**

- **Buffer (leave queued)** — only for a *future envelope version* or a *payload
  version we don't know yet*, and for a well-formed envelope of a kind we don't
  handle yet. These become valid after an app update, so dropping them would
  lose data ("buffer, never drop").
- **Discard (ack)** — anything permanently invalid: undecryptable, forged
  signature, or authenticated-but-garbage payload. Buffering those would let a
  single malformed or forged inject wedge the queue forever.
- Rows are acked **only after they are durably stored** (hold-until-ack), so a
  crash mid-drain redelivers rather than loses.
- `call-offer` and `kt-gossip` are ephemeral: always acked, never re-buffered —
  a ring redelivered long after the caller gave up must not ring again.

## Groups (D14) — as built

With no authoritative server, something still has to arbitrate membership.
Signal's answer (GroupsV2 + zkgroup) buys us nothing here: the relay **already**
learns membership from fan-out, and the zero-at-rest posture is about content and
media, not a small membership document. So: a **relay-held, signed group-state
record**, `{groupId, version, members:[{identityPubKey, role}]}`, accepted only
when signed by a current owner/admin and strictly version-incrementing
(anti-rollback). The relay does ordering and availability, not trust; clients
verify the same signatures. Documented trade: the relay learns **which admin**
made each change, because it must verify the signature.

Built today:

- `group_create` — mint a 256-bit group key, PUT the genesis record (me = owner,
  self-authorizing), register the group **verifier** derived from the group key,
  store the key locally in `groups`, create the local conversation.
- `group_add_member` — fetch the current record, append the friend's identity key
  as `member`, bump `version`, re-sign, PUT; then hand them the group key in a
  **DM-sealed `group-invite`** envelope. Their drain stores the key and creates
  the conversation, which is what makes them a member locally.
- `relay_send_group_message` / `relay_group_edit_message` /
  `relay_group_delete_message` / `relay_group_react` — one group-sealed envelope
  per action, authorized by the **group token** (derived from the group key), fanned
  out by the relay to every current member's device queues.
- Owner + admin roles are kept from the legacy model. Owner-only was considered
  and rejected: an offline owner would block every membership change, and losing
  the owner would freeze the group. Offline admin races resolve by relay
  ordering.

**Not built:** member **removal** (and therefore group-key rotation), role
changes after creation, channels inside a group, and leaving a group. A member
who has the group key keeps it — there is no revocation path yet. See
[roadmap.md](roadmap.md).

## Attachments in chat

`attachment_upload` encrypts the file under a **fresh per-file key**, uploads
only ciphertext to the relay's blob store (authorized by the friend's delivery
token or the group token), and embeds `{blobId, key, iv, mime, name, size}` in
the **sealed** message payload — so the per-file key never reaches the relay and
is readable exactly by the people who can read the message. The ciphertext is
also cached locally, because the relay deletes a blob once every recipient acks
it (and on TTL), which would otherwise cost the *sender* the ability to reopen
what they sent. Mechanics, caching and eviction:
[local-store.md](local-store.md#attachments-on-device).

⚠ The two ends of `attachments_json` currently disagree: the composer writes a
**bare array** of refs (`JSON.stringify(refs)` in `NativeChat.vue`) while
`rowToView` (`lib/nativeChat.ts`) reads a **wrapper object** `{attachments,
system}`, so a sent attachment round-trips through the relay and the log intact
but renders as nothing on either side. The unit tests mock at the view layer, so
they pass. One of the two shapes has to win — the wrapper is the one the reserved
`system` field needs.

`NativeAttachment.vue` fetches + decrypts on demand: images render inline from an
object URL (revoked on unmount), everything else is a download chip. There is no
image grid, lightbox, video poster, audio player or client-side size cap in the
native surface — all of that was legacy UI and is unbuilt here.

## The native chat surface

`/dm` → `NativeChatPage.vue`, three columns:

- **The app rail** (`AppSidebar.vue`) — every friend's DM and every group,
  ordered by most recent activity, with unread badges. See
  [ui.md](ui.md#app-shell--side-rail).
- **The conversation sidebar** (`NativeChatSidebar.vue`) — a fixed `#chat` row
  plus pinned notes in chat folders (below).
- **The messages** (`NativeChat.vue`) — one component for DMs and groups:
  list, send (text and/or attachments), edit/delete own, 👍 react, add a friend
  to a group, place a voice call in a DM. Embedded in the page with
  `hide-list`, driven by the route (`?open=dm:<contactId>|grp:<groupId>`,
  `?add=1`); standalone it also renders its own conversation list.

It re-reads the page and the reaction rows on every drain that ingested
something (`onMailIngested`), which is also what refreshes the rail's order and
unread counts (`conversation_activity` — one query for every conversation's
newest stamp + unread, so the rail costs one call, not one per row).

### Chat folders & pinned notes

A conversation's sidebar carries a fixed **`#chat`** row (the conversation
itself, and the way back from an open note) and, under it, the personal tree of
**pinned notes** grouped into **chat folders** — create / rename / delete /
nest, drag-and-drop arrangement, pin/unpin through the pin picker. Clicking a
pinned note opens it **over the messages** (`NoteEditor`, full pane), so house
rules, session notes and co-working docs live in the chat's context.

This is a **separate namespace from note folders**, keyed by conversation id in
the org store's `chat` namespace, and it is **personal**: pinning a note into a
chat does **not** share it (sharing is a note-level act — see
[notes.md](notes.md)). In the native shell that blob is persisted to the
**encrypted vault**, never `localStorage` — folder names are as sensitive as tag
names. A v8 group has no sub-channels, so a group gets the same `#chat` + pins
tree as a DM.

### Composition

**The composer is a plain text input and messages render as plain text.**
Markdown, the CodeMirror composer, `:shortcode:` emotes, the emoji picker, GIF
search, link previews, replies, threads and system notices are **not wired into
the native surface**. The relay does host privacy-proxied GIF/emote/OG endpoints
(see [relay.md](relay.md)), but no client calls them yet.

## Security properties, and the gaps

Real and enforced today:

- **Sealed sender.** A DM or group send carries no device token; the relay
  cannot attribute an envelope to an account.
- **Sender authenticity.** Every payload is signed inside the ciphertext and
  verified before ingest; the stored sender is the verified key, never a claim.
- **Conversation binding.** An inbound DM is filed under the id recomputed from
  `(me, verified sender)`; a group message under the group whose key opened it.
- **Author-gated mutation.** Edits and deletes apply only when the verified
  sender is the target's recorded author.
- **Fail-closed decode.** Undecryptable/forged/garbage is dropped, version skew
  is buffered — one bad inject cannot wedge the queue, and an app update cannot
  lose mail.
- **Nothing decrypted outlives the master key**: the conversation list, friend
  names and paging cursors are all torn down on lock (`App.vue`,
  `resetNativeChat`, `stopNativeConversations`).

Known gaps, stated plainly rather than implied away:

- **A `friend-accept` / `friend-confirm` is accepted from any sender.** The
  drain records the verified sender as a friend, and for an *accept* it also
  replies with **my handle and my delivery token**. Nothing ties the inbound
  envelope to an invite I actually minted — the `identityPub` the invite carries
  as a TOFU pin is parsed but never compared against the sender. Anyone able to
  enqueue into my mailbox (an existing friend, a live-invite holder, or the relay
  itself, which owns the queue) can therefore add themselves to my friends list
  under a handle of their choosing and be handed my delivery token. Closing it
  means remembering outstanding invites locally and matching the accept's
  verified sender against the invite's pinned key — a design change, tracked as a
  follow-up rather than silently assumed.
- **Unfriend does not revoke reach** (above): the profile-key rotation fan-out is
  unbuilt.
- **No group-key rotation**, so a member cannot be removed.
- The relay is trusted for ordering/delivery; see
  [security.md](security.md).

## Not built

Deliberately absent from the native surface, tracked in
[roadmap.md](roadmap.md) — none of it should be read into the sections above:

- **Replies** (the `reply_ref_json` column and the shared `ReplyRef` type exist;
  nothing writes or renders one — and the legacy `ReplyRef` still keys on `seq`,
  which no longer exists, so it needs re-specifying against message ids).
- **System notices** (`SystemEvent`): adding a member posts no in-band notice.
- **Channels and threads**, in any form.
- **Rich composition**: markdown rendering, emotes/emoji picker, GIF search,
  link previews, spoilers — including wiring the relay's content proxies.
- **Typing indicators and presence.** Neither the client nor the relay has any
  of it: the `ephemeral: true` envelope flag [relay.md](relay.md) specifies for
  this is **not implemented** in `routes/relay.ts`.
- **History backfill from members' devices** for a new device or a new group
  member — the signed-per-message design that makes it tamper-evident is in
  [local-store.md](local-store.md#backfill-integrity).
- **Message search in chat** (`messages_fts` exists and is populated; no UI).
- **Group member removal, roles after creation, leaving a group.**
- **In-group blocking** and the unfriend rotation fan-out.
- **Multi-relay reach / invite redemption against a non-connected relay.**
