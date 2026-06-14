# v3 — E2EE chat

**Group chat** (multi-member channels), **1:1 DMs**, and **friend lists** among
the server's users. A DM is just a two-member conversation — one unified
conversation / member / message model, not a special case. Message rendering
reuses the token-based renderer from v2.1 (no `v-html`, raw HTML inert by
construction) — see [security.md](security.md). Consecutive messages from one
sender (within ~5 min) are grouped: the sender's display name + a timestamp show
once per group (own messages included); the background/padding is on the group,
and individual messages highlight on hover.

Crypto reuses the sealing primitive from
[accounts-and-crypto.md](accounts-and-crypto.md); the app shell / sidebar is in
[ui.md](ui.md).

## Friends & ephemeral invite codes

Friends are bootstrapped with **ephemeral invite codes**, not a permanent
handle. A user generates a **randomly generated, opaque** code (never derived
from the username, never user-chosen) and shares it. Anyone holding a live code
can send that user a friend request, which the user still **accepts or
declines** — so a leaked code can't silently add anyone.

- **Reusable within a 24-hour window** (hand it to several friends at once), then
  **hard-deleted from the server and unrecoverable** — a purge sweep removes the
  row; it is not merely flagged expired.
- **Opaque by design:** there's no durable handle to correlate or leak. A vanity
  scheme (`CAM#1234`) would bake identity into the lookup key and let a curious
  host read identities out of the friend graph; a random self-destructing code
  carries no information and is dead within 24h. Enough entropy to resist
  enumeration; redemptions rate-limited. (This is the chat-side answer to the
  curious-host threat model — see [security.md](security.md).)

## Display name vs username

Each user has an editable **display name** — the only name other users ever see
(friend lists, DMs, member lists). The **username stays a login credential and
is never exposed to other users**. When a user hasn't set a display name, the
server shows a neutral `User-<id-prefix>` fallback — **never** the username.

## What is E2E-encrypted vs server-visible

Encrypted (server sees only ciphertext): **message content** and the
**conversation keys**. Server-visible **metadata**: live invite codes, display
names, the friend graph, conversation membership, message sequence numbers and
server-receipt timestamps, per-user unread markers. (The sender's own timestamp
lives *inside* the encrypted payload.) Accepted tradeoff for a trusted,
self-hosted server — see [security.md](security.md) for what could be hardened.

## Conversation keys & epochs

Each conversation has a symmetric **conversation key** that encrypts its
messages, distributed with the sealed-box primitive (`sealKey` → a member's
X25519 public key; `unsealKey` with their private key). The server stores one
sealed copy of the key **per member** (like `note_shares`).

Membership changes mint a **new epoch**: a fresh key sealed to all current
members; each message records its epoch. Clients keep every epoch key sealed to
them, so:

- **Removing a member:** the remover's client mints the new epoch and seals it
  only to the *remaining* members. The removed member keeps earlier epoch keys,
  so reads everything **up to** removal but nothing after. (Re-keying is
  client-side → requires the actor online.)
- **Adding a member — the inviter decides history:** a *share-history* flag.
  *Share* → also seal prior epoch keys to the joiner (back-scroll readable).
  *Start fresh* → only the new epoch key (visible from join point on).

Within an epoch the key is static (no per-message forward secrecy); epochs give
coarse forward/backward secrecy at membership boundaries. We deliberately do
**not** hand-roll Double Ratchet / MLS. **1:1 DMs have fixed membership → a
single epoch and none of the re-keying machinery (phase 1).**

## Delivery transport — the WebSocket

Chat needs the server to push a message the instant it arrives.

- **One authenticated socket per client** at `/api/ws`, multiplexing all
  conversations. The upgrade carries the existing **session cookie** and is
  authenticated with the same lookup as REST; cross-origin upgrades are rejected.
- **Send path stays REST:** the client `POST`s ciphertext; the server persists
  it, assigns the next per-conversation **sequence number**, returns it, then
  fans the frame out to every connected member (including the sender's *other*
  devices). REST-to-send keeps sending durable; the socket is purely the
  server→client delivery path.
- **The socket is liveness; the DB is truth.** On reconnect the client backfills
  via REST — gated on the server's `hello` frame, so an accepted-then-closed
  upgrade (Origin/cookie reject) can't drive a reconnect+re-decrypt storm.
  Ordering/durability come from DB seq numbers, so a dropped socket never loses
  a message. Single server process holding sockets in memory (the
  self-hosted reality); multi-process would need Redis pub/sub — out of scope.

### Connection limits & operational hardening

Capacity is never the bottleneck at this scale (a friends-group instance is
dozens to a few hundred sockets); these are about determinism and not leaking
resources. The OS **file-descriptor** limit (one fd/socket) is the real ceiling.

- **`ulimits: { nofile: 65536 }`** for the server in `docker-compose.yml` (don't
  leave it at a ~1024 default).
- **Heartbeat + idle timeout:** protocol ping/pong; drop sockets that stop
  answering (mobile clients vanish without a clean close).
- **Per-user connection cap** (a handful of devices/tabs); evict the oldest.
- **Bounded `maxPayload`** so one message can't balloon memory.

## Notifications

Phase 1–2: in-app only — unread badges + live delivery while foregrounded.
**Background / PWA push** (the OS banner when closed) is deferred to phase 3:
it needs the **Web Push** stack (service worker + Push API + VAPID) and leaks
sender/timing metadata to the browser's push service even though the body stays
encrypted. This deferral explicitly covers PWA message notifications.

## Phasing

- **Phase 1** — friends (ephemeral invite codes + add/accept) and **1:1 DMs**
  over the WebSocket, persisted ciphertext history, unread markers. Single epoch;
  no re-keying. **Implemented — see below.**
- **Phase 2** — **group channels:** membership add/remove, epoch re-keying, the
  inviter's share-history choice.
- **Phase 3** — hardening: CSP headers (theme-script hash) + background/PWA push.

---

## Phase 1 — as built

Built via three parallel agents against a frozen `@notes/shared` type contract.
Verified: full workspace typecheck + build; a 19-assertion in-memory DB test;
a crypto seal→unseal→encrypt→decrypt round-trip; server boots and enforces auth
(REST chat routes 401 unauth, WS rejects unauthenticated/cross-origin upgrades).

### Data model (server `db.ts`)

- `users` — gains a nullable **`display_name`** column (idempotent
  `ALTER TABLE` guarded by `PRAGMA table_info`). Effective name =
  `display_name ?? 'User-'+id.slice(0,6)` (never the username).
- `friend_invites(id, token UNIQUE, created_by, created_at, expires_at)` —
  **reusable** (no `used_by`); **hard-purged** on expiry by `purgeExpiredInvites()`
  (hourly sweep + lazy on lookup).
- `friend_requests(id, from_user, to_user, created_at, UNIQUE(from_user,to_user))`.
- `friends(user_id, friend_id, created_at, PK(user_id,friend_id))` — two rows
  per friendship for simple lookups.
- `conversations(id, kind, created_by, created_at, dm_key UNIQUE)` — `dm_key` is
  the sorted `min(uid):max(uid)` pair for DMs (NULL for groups), giving one DM
  per pair via the UNIQUE index.
- `conversation_members(conversation_id, user_id, sealed_key, epoch DEFAULT 0,
  last_read_seq DEFAULT 0, joined_at, role, PK(conversation_id,user_id))` —
  `sealed_key` = JSON `SealedKey`.
- `messages(id, conversation_id, sender_id, seq, epoch, ciphertext, iv,
  created_at, UNIQUE(conversation_id,seq))` + `idx_messages_conv_seq`. `seq` is
  assigned `MAX(seq)+1` inside a transaction.

### REST routes (`routes/chat.ts`, all `requireAuth`)

Invites/friends: `POST/GET /api/friend-invites`, `DELETE /api/friend-invites/:id`,
`POST /api/friends/redeem` (rejects own/expired, dedupes existing friendship &
either-direction request), `GET /api/friends/requests`,
`POST /api/friends/requests/:id/accept|decline`, `GET /api/friends`,
`DELETE /api/friends/:userId`.
Profile: `GET/PUT /api/profile` (display name, 1..50 chars).
Conversations: `GET /api/conversations`, `POST /api/conversations/dm`
(idempotent on `dm_key`, members must be exactly {me, friend}),
`GET /api/conversations/:id/messages?before=&limit=` (DESC, ≤100),
`POST /api/conversations/:id/messages` (assigns seq, fans out), 
`POST /api/conversations/:id/read` (advances `last_read_seq`, fans out a receipt).

### Realtime hub (`realtime.ts`)

`createRealtime(db, config)` → `{ register(app), sendToUser, sendToUsers(ids,
frame, exceptUserId?), isOnline }`. The `/api/ws` upgrade authenticates via the
`notes_session` cookie (sha256 → session → user) and **requires** a matching
`Origin`; unauthenticated sockets are closed before any frame. In-memory
`Map<userId, Set<socket>>`; on open sends `{type:'hello'}` and broadcasts
presence to online friends; heartbeat every 30s (ping/`isAlive`); per-user cap 8
(evict oldest); `maxPayload` 64 KiB. Server→client `ServerFrame`s: `hello`,
`message`, `read`, `friend-request`, `friend-accepted`, `presence`. Send/read
go over REST; client→server frames are minimal (liveness is protocol ping/pong).

### Client crypto & state

- `chatCrypto.ts` — `generateConversationKey`, `sealConversationKey`,
  `unsealConversationKey`, `encryptMessage`/`decryptMessage` (AES-256-GCM over a
  JSON `MessagePayload {text, sentAt}`).
- **DM creation:** the client generates a conv key, seals it to **both** members'
  public keys, and `POST`s. Because the create endpoint is **idempotent**, the
  client always derives its in-memory key by **unsealing the server-returned
  `sealedKey`**, never the locally-generated key — so an already-existing DM
  (other device / race) resolves to the right key.
- `chatSocket.ts` — reconnecting WS client (exponential backoff). `chat.ts`
  store wires frames to both the chat and friends stores and backfills on every
  (re)connect; `startChat()/stopChat()` are hooked to session unlock/lock.
  Conversation keys are held in an in-memory `Map` only (never persisted).
- Self-echo dedupe by `seq`; an inbound message for an unknown conversation
  triggers `loadConversations()` first (so a friend's opening DM appears).

### Security decisions from review

- **Unfriending revokes DM access** but preserves history: a `canAccess` gate
  requires membership **and**, for a DM, current friendship — re-friending
  restores access. (No data deleted.)
- WS upgrade **requires** a present, matching `Origin` (stricter than the REST
  CSRF check, safe because browsers always send Origin on WS handshakes).
- `accept` clears any reverse-direction friend request to avoid an orphan.
- Confirmed safe in review: IDOR/membership on every conversation route, seq
  atomicity, `dm_key` idempotency race-safety, fan-out membership scoping, SQL
  parameterization, no username leakage.

### Files

Server: `db.ts`, `realtime.ts`, `routes/chat.ts`, `app.ts`, `index.ts`,
`package.json` (+`@fastify/websocket`). Shared: chat types in `index.ts`.
Web: `lib/chatCrypto.ts`, `lib/chatSocket.ts`, `lib/api.ts`, `stores/chat.ts`,
`stores/friends.ts`, `components/AppSidebar.vue`, `pages/FriendsPage.vue`,
`pages/ConversationPage.vue`, `components/AppLayout.vue`, `App.vue`, `router.ts`,
`pages/SettingsPage.vue` (display-name field).

### Not yet verified

A true two-user browser flow (passkey login → friend → send an encrypted
message, observing realtime delivery) — passkey ceremonies are browser-only, so
this is the one check left and the first target in [testing.md](testing.md).
