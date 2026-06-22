# v3 — E2EE chat

**Group chat** (multi-member channels), **1:1 DMs**, and **friend lists** among
the server's users. A DM is just a two-member conversation — one unified
conversation / member / message model, not a special case. Message rendering
reuses the token-based renderer from v2.1 (no `v-html`, raw HTML inert by
construction) — see [security.md](security.md). Layout is a full-width list
(Discord-style): one row per message with a left **avatar gutter**. Consecutive
messages from one sender (within ~5 min) are grouped — the first row shows the
**avatar** + display name + timestamp (own messages included); the rest leave the
gutter empty, where each message's own timestamp appears **on hover**. Messages
have **no background** and stack as tight lines (4 in a row read like one 4-line
message); only a per-message **hover highlight** distinguishes them. Everyone's
messages align the same way (inline-start — left in LTR, right in RTL); your own
are not special-cased. The default avatar is a colored circle (deterministic per
user) with the first letter of the display name — `ChatAvatar.vue`.

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
is never exposed to other users**. **Registration captures the display name up
front** (a required field in `RegisterFlow.vue`, persisted via `profileSet`
once the new session is authenticated) so accounts aren't nameless; it's also
editable later in Settings → Profile. When a user still has no display name
(legacy/empty), the server shows a neutral `User-<id-prefix>` fallback —
**never** the username.

Each user may also pick a **name color** shown to others in chat. Choices are
restricted to the curated **`NAME_COLORS`** palette (the `--brand-*` accents,
each a `light-dark()` pair) — a free color picker is deliberately *not* offered,
so every choice stays readable in every theme. Stored server-side as the color
name (`users.name_color`, validated against the palette; null = default),
surfaced on `ProfileInfo` and each `ConversationMember`, and rendered as
`color: var(--brand-<name>)` on the sender's name (message header, reply quote,
replying-to banner). Set it in Settings → Profile.

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
X25519 public key; `unsealKey` with their private key). Because a group re-keys
on every membership change, the server keeps each member's sealed key **per
epoch** in a `conversation_keys` table (`conversation_members.sealed_key` holds
only the current one); `toConversation` returns the member's full `epochKeys`
list, and the client unseals each into a `convId → epoch → key` map. Keeping all
epoch keys server-side is what lets a re-keyed group's **back-scroll survive a
reload** (the in-memory cache is lost).

Membership changes mint a **new epoch**: a fresh key sealed to all current
members; each message records its epoch and is decrypted with the key for *that*
epoch. Clients keep every epoch key sealed to them, so:

- **Removing a member (or leaving):** the actor's client mints the new epoch and
  seals it only to the *remaining* members; the target's `conversation_keys` rows
  are deleted. The removed member reads everything **up to** removal (via keys
  already in memory) but nothing after. (Re-keying is client-side → requires the
  actor online.)
- **Adding a member — the inviter decides history:** a *share-history* flag.
  *Share* → also seal every prior epoch key to the joiner (back-scroll readable).
  *Start fresh* → only the new epoch key (unread starts at the latest seq;
  earlier messages aren't decryptable).
- **The server enforces the fresh boundary** (not just the missing keys): each
  member has a **history floor** `since_seq` (`conversation_members.since_seq`,
  0 = full history). A fresh-history join sets it to the conversation's max seq at
  join time; share-history joins and original members stay at 0. `listMessages` /
  `listReactions` only return rows with `seq > since_seq`, so a fresh joiner is
  **never even sent** pre-join ciphertext (no "could not be decrypted" leak, and
  no metadata about messages they can't read). A one-time, idempotent migration
  backfills the floor for existing fresh joiners (detected as members lacking the
  genesis epoch-0 key), using the max seq at their `joined_at`.

The server validates each re-key: the `keys` must cover **exactly** the expected
member set, `epoch` must be `current + 1`, and a share-history join's `priorKeys`
must cover epochs `0..current` — so a partial or stale re-key is rejected, never
half-applied.

**Permissions.** Members carry a `role` (`owner` = creator, `admin`, `member`).
The pure `canManageMembers(role)` rule (in `@notes/shared`, enforced server-side
and used for client affordances) decides who may add/remove/change roles: owners
**and admins** can — **admins have the same powers as the owner**, with two
exceptions baked into the routes: an admin can never **remove or demote the
owner**, and only the owner can't have their role changed at all. Anyone may
**leave**; an owner who leaves hands ownership to the earliest-joined remaining
member; a group never drops below two members. Live membership/epoch/role
changes fan out as a `conversation-updated` frame (recipients refetch); a removed
member gets `conversation-removed` (drops it). (There is no configurable
per-group "who can manage" policy — admins always can.)

Within an epoch the key is static (no per-message forward secrecy); epochs give
coarse forward/backward secrecy at membership boundaries. We deliberately do
**not** hand-roll Double Ratchet / MLS. **1:1 DMs have fixed membership → a
single epoch and none of the re-keying machinery.**

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
- **Phase 2** — **group channels:** membership add/remove + leave, epoch
  re-keying, the inviter's share-history choice, and per-group permissions
  with owner/admin roles (admins share the owner's powers, can't remove the
  owner). **Implemented — see above.**
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
  the sorted `min(uid):max(uid)` pair for DMs (NULL for groups), giving one DM per
  pair via the UNIQUE index. (A legacy `manage_policy` column from an earlier
  design still exists but is unused — admins always manage.)
- `conversation_members(conversation_id, user_id, sealed_key, epoch DEFAULT 0,
  last_read_seq DEFAULT 0, joined_at, role, PK(conversation_id,user_id))` —
  `sealed_key` = the current epoch's JSON `SealedKey`; `role` is
  `owner`|`admin`|`member`.
- `conversation_keys(conversation_id, user_id, epoch, sealed_key,
  PK(conversation_id,user_id,epoch))` — every epoch key a member can read (kept
  so back-scroll survives a re-key + reload); a member's rows are deleted when
  they leave/are removed, which cuts their future access.
- `messages(id, conversation_id, sender_id, seq, epoch, ciphertext, iv,
  created_at, edited_at, UNIQUE(conversation_id,seq))` + `idx_messages_conv_seq`.
  `seq` is assigned `MAX(seq)+1` inside a transaction. `edited_at` is null until
  the message is edited (`editMessage` updates ciphertext/iv + stamps it, guarded
  by `sender_id` so only the author can edit).

### REST routes (`routes/chat.ts`, all `requireAuth`)

Invites/friends: `POST/GET /api/friend-invites`, `DELETE /api/friend-invites/:id`,
`POST /api/friends/redeem` (rejects own/expired, dedupes existing friendship &
either-direction request), `GET /api/friends/requests`,
`POST /api/friends/requests/:id/accept|decline`, `GET /api/friends`,
`DELETE /api/friends/:userId`.
Profile: `GET/PUT /api/profile` (display name, 1..50 chars).
Conversations: `GET /api/conversations`, `POST /api/conversations/dm`
(idempotent on `dm_key`, members must be exactly {me, friend}),
`POST /api/conversations/group` (creates a `kind:'group'` conversation of 3+
members — me plus 2+ friends; **not** idempotent, every other member must be a
current friend of the creator; the creator is the `owner`),
`GET /api/conversations/:id/messages?before=&limit=` (DESC, ≤100),
`POST /api/conversations/:id/messages` (assigns seq, fans out), 
`PATCH /api/conversations/:id/messages/:seq` (edit: re-encrypted ciphertext/iv
under the message's own epoch; **sender-only**, 403 otherwise; stamps `edited_at`
and fans out a `message-edited` frame),
`POST /api/conversations/:id/read` (advances `last_read_seq`, fans out a receipt).
Group membership (Phase 2, all re-key-validated & permission-gated):
`POST /api/conversations/:id/members` (add a friend, mints a new epoch sealed to
everyone + joiner, `history: share|fresh`),
`DELETE /api/conversations/:id/members/:userId` (remove, or leave when it's you;
re-keys the remainder),
`POST /api/conversations/:id/members/:userId/role` (owner/admin grants/revokes
admin; the owner's role is immutable).

### Realtime hub (`realtime.ts`)

`createRealtime(db, config)` → `{ register(app), sendToUser, sendToUsers(ids,
frame, exceptUserId?), isOnline }`. The `/api/ws` upgrade authenticates via the
`notes_session` cookie (sha256 → session → user) and **requires** a matching
`Origin`; unauthenticated sockets are closed before any frame. In-memory
`Map<userId, Set<socket>>`; on open sends `{type:'hello'}` and broadcasts
presence to online friends; heartbeat every 30s (ping/`isAlive`); per-user cap 8
(evict oldest); `maxPayload` 64 KiB. Server→client `ServerFrame`s: `hello`,
`message`, `message-edited`, `read`, `friend-request`, `friend-accepted`,
`profile-updated`, `conversation-updated`, `conversation-removed`, `presence`.
Send/read/edit go over REST; client→server frames are minimal (liveness is
protocol ping/pong).

### Client crypto & state

- `chatCrypto.ts` — `generateConversationKey`, `sealConversationKey`,
  `unsealConversationKey`, `encryptMessage`/`decryptMessage` (AES-256-GCM over a
  JSON `MessagePayload {text, sentAt}`), plus the re-key helpers
  `sealConversationKeyToMembers` (one new key → many members) and
  `sealEpochKeysTo` (prior epoch keys → a share-history joiner).
- **DM creation:** the client generates a conv key, seals it to **both** members'
  public keys, and `POST`s. Because the create endpoint is **idempotent**, the
  client always derives its in-memory key by **unsealing the server-returned
  `sealedKey`**, never the locally-generated key — so an already-existing DM
  (other device / race) resolves to the right key.
- **Group creation** (`chat.openGroup`): same machinery as a DM but the conv key
  is sealed to **me + every selected friend**. The **New chat** modal
  (`NewChatModal.vue`, built on the reusable `AppModal`) lets you check one or
  many friends — one → a DM, many → a group. Members discover a new group the
  same way as a DM: the first `message` frame for an unknown conversation
  triggers a `loadConversations()`.
- **Group membership** (`chat.addMember`/`removeMember`/`setMemberRole`): the
  actor mints a new conv key, seals it to the post-change member set, and (on a
  share-history add) seals every prior epoch key to the joiner, then POSTs.
  `ManageMembersDrawer.vue` — a slide-in drawer (the reusable `AppDrawer.vue`)
  opened from a members button on the **right of the group header** — drives it:
  member list with owner/admin badges, remove (X) and admin grant/revoke (gated
  on `canManageMembers`), and **Leave**. An **Add friend** button at the top opens
  `AddGroupMemberModal.vue` (the standard `AppModal` picker) with the per-add
  share/start-fresh toggle. A `conversation-updated` frame triggers a
  `loadConversations()` (picks up new members + epoch keys); `conversation-removed`
  drops the conversation.
- **Editing** (`chat.editMessage`): re-encrypts the new text under the message's
  **own epoch key** (so the same recipients can read it) — preserving the original
  non-text payload (gif/attachments/reply/preview) — and `PATCH`es it. The
  inbound `message-edited` frame replaces the message in place by `seq` (never
  advances unread); the bubble shows a muted **"(edited)"** marker. The hover
  toolbar shows an **Edit** (pencil) action on your **own** decryptable text
  messages; it loads the text into the composer with an **Editing** banner
  (Enter saves, Esc / ✕ cancels). Pressing **↑ in an empty composer** starts
  editing your most recent editable message (MarkdownEditor emits `editLast`).
- **Touch actions** (`MessageActionsSheet.vue`): on a **coarse pointer**,
  long-pressing a message (~500 ms, cancelled by scroll/lift) opens a **slide-up
  bottom sheet** with quick reactions + the emoji picker, Reply, Edit (own), and
  Open thread. Gated on `pointerType === 'touch'` — **mouse/pen keep the hover
  toolbar** at every screen size. The OS long-press callout is suppressed on
  touch; the sheet is a bottom-anchored reka Dialog at `z-modal`.
- **System notices.** Adding a member also posts an ordinary **encrypted message**
  carrying a `MessagePayload.system` event (`{kind:'member-joined', userId,
  phrase}`) at the new epoch — so the joiner can read it and the server never sees
  it. The client renders `system` messages as a **centered, muted line** (no
  bubble/avatar) and picks a (sometimes silly) join phrase from
  `lib/systemMessages.ts`; a join you made yourself reads "You joined the chat."
- `chatSocket.ts` — reconnecting WS client (exponential backoff). `chat.ts`
  store wires frames to both the chat and friends stores and backfills on every
  (re)connect; `startChat()/stopChat()` are hooked to session unlock/lock.
  Conversation keys are held in an in-memory `convId → epoch → key` `Map` only
  (never persisted); each message decrypts under the key for its own epoch.
- Self-echo dedupe by `seq`; an inbound message for an unknown conversation
  triggers `loadConversations()` first (so a friend's opening DM appears).
- **Infinite history scroll:** `ConversationView` auto-loads the next older page
  (`loadHistory(convId, oldestSeq)`, `HISTORY_LIMIT` 50) when the user scrolls
  near the top — no "load older" button. `loadHistory` returns the fetched count;
  a page shorter than the limit sets `reachedStart`, which stops further loads
  and shows an **"End of message history"** marker. Scroll anchoring is preserved
  by measuring height before the loading indicator renders and restoring
  `scrollTop = scrollHeight − prevHeight` after the rows prepend (no jump).

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

---

## v3.1 — Chat polish (as built)

Incremental polish on top of phase 1; each item below is the as-built record.

### Composer — the v2.1 live editor reused

The composer is the same `MarkdownEditor.vue` used in notes (CodeMirror live
preview: code blocks, spoilers, colors, the selection toolbar), not a plain
`<textarea>`. Two composer-only props keep the notes editor untouched:

- **`submit-on-enter`** — binds **Enter → `submit`** (ahead of the default
  keymap) and **Shift+Enter → newline**; also switches sizing from "fill the
  pane" to **auto-grow up to `max-height: 40vh`, then scroll**. Inside a list,
  **Enter continues the list** (new item, via `insertNewlineContinueMarkup`)
  instead of sending; **Cmd/Ctrl+Enter sends** regardless of list context.
- **`placeholder`** — composer shows `Message…`.

There is **no visible Send button** — Enter sends. An `sr-only` submit button
remains for screen-reader/keyboard users. The composer's only visible controls
are attach (📎) and the emoji/GIF picker.

Messages already render through the same token renderer (`MarkdownView`), so a
sent message renders with identical formatting to the live preview — no
`v-html`, raw HTML inert by construction (see [security.md](security.md)).

### GIF search — KLIPY, proxied

GIFs are searched through a **server-side proxy** (`routes/gifs.ts`:
`GET /api/gifs/search?q=&pos=`, `GET /api/gifs/trending?pos=`, both
`requireAuth`). The proxy:

- keeps the **`KLIPY_API_KEY`** server-side (from `.env`; never shipped to the
  browser). With no key set, the routes return **503** and the picker shows
  "GIF search isn't configured".
- **normalizes** KLIPY's `size × format` matrix to `{id, title, url, previewUrl,
  width, height}` — animated **webp** preferred (far smaller than gif), gif
  fallback; `md` for the embed URL, `xs` for the picker thumbnail. Items with no
  usable media are dropped. `next` is the next page number or null.
- passes an opaque per-user `customer_id` (`sha256('klipy:'+userId)`), and maps
  upstream errors to **502**.

The chosen GIF is embedded in the **encrypted** `MessagePayload.gif`
(`GifRef`) — a small CDN URL + dimensions, never inline bytes (the WS frame cap
is 64 KiB). So **the server never learns which GIF was sent.** The recipient's
client loads the animated media directly from KLIPY's CDN — a third-party
metadata tradeoff (recipient IP/timing), documented in
[security.md](security.md). GIF search is a **tab in the emoji picker**
(`EmojiPicker.vue`, debounced, trending on open) — picking emits a `gif` event
that sends the message; a purely-GIF message has empty `text`. (There is no
separate GIF button and no visible Send button — see the composer note above.)

### Encrypted attachments

Chat attachments reuse the **note** attachment machinery unchanged: the client
optimizes (images), encrypts the blob with a **fresh per-file AES-256-GCM key**
(`encryptAndUploadFile` → `lib/attachments.ts`), uploads ciphertext to the
capability-style `POST /api/attachments`, and embeds the resulting
`AttachmentRef` (`{id, name, type, size, key, iv}`) in
`MessagePayload.attachments`. Because that payload is itself sealed under the
conversation key, only conversation members can read the per-file key — so the
attachment is **effectively conversation-keyed** (the same indirection notes
use), without a second key-distribution mechanism.

The composer (`+` button) uploads each picked file immediately and stages it as
a removable chip; **Send** embeds the staged refs with the (optional) text.
Rendering splits a message's refs (`ChatAttachments.vue`): images collapse into a
single **image grid**, other files follow as download chips. Each blob is
decrypted locally (`decryptAttachment` → `lib/attachments.ts`) to an object URL,
so (like note attachments) there's **no remote fetch and no IP leak**. The
per-file size cap mirrors the server's 32 MiB.

A message's images render as a **grid** (`ChatImageGrid.vue`): one image shows at
its natural aspect; two or four tile in two columns, everything else in three
(square, cover-cropped thumbnails). Past **5** images the first five tiles show
and the remainder collapse behind a **`+N`** badge on the last visible tile —
clicking it opens the lightbox at that image so the arrows reveal the rest. The
visible-count / overflow / column math is the pure, unit-tested
`lib/imageGallery.ts` (`galleryLayout`); `stepIndex` clamps lightbox paging to
the batch (no wrap).

Clicking a tile opens `ImageLightbox.vue`, a full-bleed viewer (reka-ui Dialog;
Escape / overlay-click / close-button dismiss) shared across the batch:
**left/right arrows** (and the **←/→ keys**) page through the message's images,
hidden at the ends. Swapping the shown image resets zoom/pan. A plain
**click toggles** between fit-to-screen and a zoomed-in view anchored on the
cursor; **click-and-hold drags** to pan once zoomed (the wheel also zooms toward
the cursor). The pan/zoom math is the pure, unit-tested `lib/imageZoom.ts`
(`zoomToPoint` pins the cursor point across a scale change; `clampPan` keeps the
scaled image from revealing a gap past its edges). A corner overlay shows the
file metadata — name, pixel **dimensions** (read from the loaded image's natural
size), **size**, and **format** (`formatBytes` / `formatMime` in
`lib/fileMeta.ts`, also unit-tested).

Opening/closing **morphs** the active thumbnail into the modal image via the View
Transitions API: both elements share a temporary `view-transition-name` (keyed to
the **currently-shown** image's attachment id, assigned only while a transition is
in flight — so paging between photos doesn't morph, only open/close, and an image
hidden behind `+N` simply cross-fades since it has no tile to pair with). The
open/close state change is wrapped in `withViewTransition`
(`lib/viewTransition.ts`, which feature-detects and respects
`prefers-reduced-motion`, otherwise mutating directly). The lightbox is **fully
controlled** by `ChatImageGrid` so it can't tear down before the morph captures
its snapshot. The transition captures **only the image** (`excludeRoot` drops the
default whole-page `root` snapshot); the backdrop and chrome stay live and fade
with their own CSS, so the blur ramps smoothly and the chrome fades in after the
image settles rather than being painted over by the morphing snapshot.

### Replies

A reply embeds a `ReplyRef` snapshot — `{seq, senderId, preview}` — in the
sender's encrypted `MessagePayload.replyTo`. The `preview` is a short plaintext
snippet the sender already holds (text, or `[GIF]` / `[N attachments]`), so the
quote renders **even before the parent is loaded** and survives the parent
becoming unreadable. No server change: replies are pure payload.

UI (`ConversationPage.vue`): a hover **Reply** action stages a "replying to…"
banner above the composer (cancellable); **Send** embeds the `ReplyRef`. Each
message renders its quote as a clickable line that scrolls to the parent (`rows`
carry `data-seq`).

### Reactions (encrypted per-conversation)

A reaction's **emoji is encrypted with the conversation key**, so the server
stores opaque blobs and can't read which emoji was used; clients decrypt and
aggregate. Server (`message_reactions` table + routes, all membership-gated):

- `POST /api/conversations/:id/messages/:seq/reactions {ciphertext, iv}` — add;
  fans out a `reaction` frame.
- `DELETE /api/conversations/:id/reactions/:rid` — remove; **owner-only** (IDOR
  guard) and scoped to the conversation; fans out `reaction-removed`.
- `GET /api/conversations/:id/reactions` — list (clients decrypt + group).

The emoji string (a unicode char, `:emote:`, or `:customName:`) is sealed via
`encryptReaction` (same AES-GCM as messages). The store groups by emoji per
message; `toggleReaction` removes my existing reaction with that emoji or adds
one. UI: a hover **react** action (the emoji picker) and reaction pills under
each message (count + highlighted when mine) that toggle on click.

### Threads

A **thread is a child conversation** (`kind: 'thread'`) hung off a parent
message — so it reuses the entire conversation machinery (its own key/epoch,
messages, reactions, realtime fan-out, and `ConversationPage` itself) rather
than inventing a parallel model. `conversations` gains `parent_id` +
`parent_seq` (idempotent migration) with a **partial unique index** on
`(parent_id, parent_seq)` → one thread per parent message.

- `POST /api/conversations/:id/messages/:seq/thread {members}` — membership-gated,
  idempotent. The thread key is sealed to **exactly the parent's members** (so
  everyone who can see the parent can read the thread); the server validates the
  member set matches. Rejects threading a thread, and an out-of-range `seq`. A
  1:1 thread inherits the DM's friendship gate (unfriending revokes it too).
- Threads are ordinary conversations in `GET /api/conversations`, so loading +
  key-unseal + inbound delivery all work unchanged. The client (`openThread`)
  seals the new key to all parent members, like a DM but for N members.

UI: the conversation body is a reusable `ConversationView` (driven by a `convId`
prop), so the parent and a thread render as two instances. A hover thread action
(and a **"N replies"** link) opens the thread; `ConversationPage` holds the
active-thread id, renders the **conversation name in a shared header above both
panes** (the parent `ConversationView` is `hide-header`; the thread panel keeps
its own header), and chooses the layout from the **chat region's** width
(measured with a `ResizeObserver`, not the viewport, so the sidebar state
counts). At **≥768px** the thread is a **resizable right-hand panel** — its own
flex column defaulting to **half** the region, with a **drag handle** on the
separating line (clamped so neither side collapses); below that it's a
full-cover overlay with a close button. The sidebar **excludes** `thread`
conversations (reached from their parent message, not listed top-level).

This completes the v3.1 "reactions, replies, and threads" bullet.

### Custom emoji — default 7TV set

A few hundred of the most-used 7TV emotes back the default set. The binaries are
**not committed**; instead the server **proxies and disk-caches** each image
from 7TV's CDN on first request and serves it from our own origin
(`server/routes/emoji.ts`, `GET /emoji/7tv/:id.webp`, `requireAuth`, validated
26-char ULID only → never an open proxy; `Cache-Control: immutable`). That keeps
the self-hosting privacy/offline posture (no per-render IP leak to 7TV;
service-worker cacheable) without ~300 binaries in the repo. The **metadata set**
(`web/src/lib/emoji/defaultEmoji.json`, names → 7TV ids, **in 7TV popularity
order**) is refreshed from 7TV's GQL (`filter.category = TOP`) by
`scripts/fetch-emojis.mjs` (now metadata-only). The bundled manifest seeds
`resolveEmoji` synchronously; images load from `/emoji/7tv/…`, excluded from the
PWA precache and cached on demand via a `CacheFirst` runtime rule.

Messages use Discord-style **`:shortcode:`** syntax. The token renderer
(`MdTokens.emojiText`) replaces a `:name:` run with an inline `<img.chat-emoji>`
when `resolveEmoji(name)` matches; unknown shortcodes stay literal, and code
spans/blocks are never substituted (so `` `:KEKW:` `` stays text). The set is
global UI chrome, so notes render them too. `EmojiPicker.vue` is a searchable
two-tab popover; picking inserts at the composer caret via the editor's exposed
`insertText`. Picking from any tab **records a use** (see Most-used ranking
below), and a **Frequently used** row sits at the top of the picker while not
searching.

### Unicode emoji search (emojibase)

The picker's **Emoji** tab searches the local unicode set from `emojibase-data`
(`lib/emoji/unicode.ts`). The ~1,900-entry dataset is **dynamically imported**
the first time the tab opens (a lazy ~82 KB-gzip chunk, kept out of the main
bundle) and cached; component glyphs (skin tones/hair, group 2) are excluded.
Search is substring over label + tags; picking inserts the raw unicode
character (no shortcode needed — it renders natively).

> Hosting note: the default set's images are server-proxied + cached from 7TV's
> CDN (above) rather than committed — resolved in v3.4.

### Most-used ranking (synced, decayed)

The picker and the `:`-autocomplete float **frequently-used** emoji to the top.
`lib/emoji/usage.ts` keeps a per-emoji `{ score, lastUsed }` map: each use
**decays** the prior score (exponential, 14-day half-life) then adds 1, so a
recent burst overtakes an old habit within ~2 weeks. The map is a master-key-
encrypted **settings blob** (key `emoji-usage`, same `wrapKey`/`settingPut`
mechanism as the custom-emoji palette), so usage **follows the account across
devices** and the server never sees it; it loads on connect (`loadEmojiUsage`)
and clears on lock/logout (`resetEmojiUsage`). Entries are pruned to the top 300
before each (debounced) save. Keys are **source-tagged** (`7tv:`/`custom:`/
`uni:`) so the same name across sources — and the same glyph — never collide.

`rankEmoji(query, unicodeList)` returns one merged, de-duped list ordered as: a
**most-used tier** (positive decayed score, any source) on top, then **custom →
7TV → unicode** in their natural order. Each result carries its insert text
(`:shortcode:` or the glyph) and render data (image url or char).

### `:` autocomplete (composer + note editor)

`MarkdownEditor.vue` (the shared editor used by both the chat composer and the
note editor) opens a **Discord-style inline completion** when you type `:abc`.
The trigger (`lib/editor/emojiTrigger.ts`) requires the colon to start a line or
follow whitespace and at least two name chars to follow — so `http://` and a
bare `:` never pop it, and it's suppressed inside code. Results come from
`rankEmoji` (most-used → custom → 7TV → unicode); the unicode set is lazy-loaded
on first trigger. **↑/↓** move, **Enter/Tab** accept, **Esc** dismisses (a
top-precedence keymap owns these only while the list is open, so Enter still
sends/continues lists otherwise). Accepting replaces the typed `:abc` with the
`:shortcode:` (or glyph) and **records a use**.

### Link previews (v3.4)

**Opt-in, off by default**, and only generated when **every** member of the
conversation has them enabled (`users.link_previews`, surfaced on each
`ConversationMember`; the sender's client gates on `members.every(linkPreviews)`).

Because a browser can't fetch arbitrary cross-origin pages, the **sender's
client** asks the server to fetch the URL via `GET /api/og?url=` and embeds the
returned `LinkPreview {url,title,description,image,siteName}` inside the
**encrypted** message payload (Signal-style) — so recipients render it from the
decrypted payload and the server only ever saw the URL at proxy time. The
preview image is a remote URL rendered with the usual **click-to-load**
(`LinkPreviewCard.vue`).

When previews are **not** allowed (not every member has them on) and a message
contains a URL, the message renders a small grey **hint** where the preview would
have been ("every member needs link previews enabled"), so it's clear why no card
appears — distinct from a message that simply yielded no OG data.

The proxy (`server/routes/og.ts`) is an **SSRF surface** and is guarded: http(s)
only; the host must resolve to a **public** IP (loopback/private/link-local/
CGNAT/cloud-metadata/multicast all blocked, IPv4 + IPv6); redirects are followed
**manually and re-validated each hop**; the response is **size- and
time-capped** and must be HTML. OG/`<meta>` tags are parsed from the `<head>`
with no HTML execution, and HTML entities are decoded in a **single pass** so
escaped markup (e.g. `&amp;lt;`) can't be double-unescaped back into live tags.
DNS rebinding is closed at the socket layer — the fetch uses an undici
dispatcher whose lookup re-validates the resolved IP at connect time, so a host
can't pass the pre-check and then connect to a private address.

### Custom (encrypted) per-user emoji

A user uploads their own emoji (Settings → Custom emoji). Each image is an
**encrypted attachment** (fresh per-file key, via `encryptAndUploadFile`); the
palette (`name → AttachmentRef`) is stored as a **master-key-encrypted settings
blob** (`chat-emoji`, like tag colors), so the server never sees the names or
images. `lib/emoji/custom.ts` loads + decrypts the palette on chat start and
registers each as an object URL so `:name:` renders; the picker's **Custom** tab
inserts them.

When a message uses a custom emoji, its ref is embedded in the encrypted
`MessagePayload.customEmoji` (name → ref). On decrypt, the recipient registers
those (decrypting the blob to an object URL) **before** the message view is
shown, so it renders for everyone — without sharing the whole palette. Names are
registered into one global map, so across users the last-seen `:name:` wins (fine
at this app's scale).

## v4 — Chat sidebar + channels (as built)

Groups gain Discord-style **channels**: separate message streams inside one
conversation. A channel is purely an *organizational partition* — all channels
of a conversation **share its key and epochs**, so adding a channel needs **no
new key distribution** and a new group member can read every channel
immediately. What a channel adds over the conversation is its own **message
ordering and per-member read state** (so unread is tracked per channel).

### The "general" channel is virtual

Every conversation has a **general channel whose id equals the conversation id**
(`channelId === conversationId`). It isn't a row anywhere — it's the
conversation's original message stream. Extra channels (groups only) are rows in
the `channels` table with distinct ids. This means **DMs and threads are
completely unchanged** (their messages all sit in the general channel) and the
v4 migration needed no data move beyond tagging existing rows.

### Data model (server `db.ts`)

- **`channels`** `(id, conversation_id → conversations ON DELETE CASCADE, name,
  type ['text'|'voice'], position, created_at)` — only *extra* channels; the
  general channel is virtual. Voice channels are structural placeholders (the
  voice feature itself is v6).
- **`messages.channel_id`** / **`message_reactions.channel_id`** — added by an
  idempotent migration that backfills `channel_id = conversation_id` for all
  existing rows. `seq` stays **monotonic per conversation** (the shared
  generator) — it's the conversation-unique anchor for replies/threads/edits — so
  pagination/ordering within a channel is just `WHERE channel_id = ? ORDER BY
  seq`. Indexed by `(channel_id, seq)`.
- **`channel_reads`** `(channel_id, user_id, last_read_seq)` — per-(channel,
  member) read cursor for *extra* channels. The **general** channel's cursor
  stays on `conversation_members.last_read_seq`, untouched.

### REST routes (`routes/chat.ts`)

- `POST /api/conversations/:id/channels` `{name, type}` — create (groups only,
  gated on the same `canManageMembers` owner/admin permission as membership).
- `PATCH /api/conversations/:id/channels/:channelId` `{name}` — rename.
- `POST /api/conversations/:id/channels/reorder` `{order}` — reorder; `order`
  must be a permutation of exactly the conversation's extra channels.
- `DELETE /api/conversations/:id/channels/:channelId` — delete the channel and
  all its messages/reactions/read cursors. The general channel can't be
  renamed/reordered/deleted (it isn't a row → 404).
- The **message / read / reaction** routes take an optional `channelId`
  (query for GET, body for POST), validated to belong to the conversation
  (`resolveChannel`; absent ⇒ general). A reaction's channel is derived
  **server-side from the target message**, never trusted from the client.
- A `Conversation` now carries `channels: ChannelInfo[]` (always including the
  general channel at position 0, each with its own `lastSeq`/`lastReadSeq`).

### Realtime

`message` / `message-edited` / `reaction` frames carry the message's
`channelId`; `read` and `reaction-removed` frames carry it too. A
`channels-updated` frame (with an optional `deletedChannelId`) tells members to
refetch the channel list after a create/rename/reorder/delete.

### Client

- The chat store keys `messages`/`reactions` by **channel id** (so DMs/threads
  key by their conversation id exactly as before) and tracks per-channel
  unread, with a conversation's unread = the **sum of its channels'** unread.
  Channel actions (`createChannel`/`renameChannel`/`reorderChannels`/
  `deleteChannel`) plus an `activeChannelId` for reconnect backfill.
- Unread is surfaced as a **red** count badge on the conversation (rail) and
  channel (`ChatSidebar`) rows. The store also exposes `totalUnread` (sum across
  non-thread conversations); `App.vue` mirrors it into the **browser tab title**
  (`(n) …`) and the installed-PWA **app-icon badge** (`navigator.setAppBadge`,
  cleared at zero; a no-op where the Badging API is unavailable).
- `ConversationView` takes a `channelId` prop (default = general) and
  re-activates when the channel changes. The active channel lives in the **route**
  (`/chat/:id` = general, `/chat/:id/:channelId` = an extra channel), so a refresh
  keeps you in the channel; a stale/deleted channel id redirects to general.
- `ChatSidebar` is a **unified tree** (like the notes tree): collapsible with a
  persisted open/closed state (`localStorage` `chat:channels:open`) and a toggle
  at the top. It lists **channels** (groups; per-channel unread badges; voice
  channels listed but not selectable) and **pinned notes** as items, organized by
  **chat folders**. Header buttons: pin a note, new folder, new channel
  (managers). Channel rename/delete are inline hover actions (managers,
  non-general). Everything is drag-and-drop — drag an item into a folder, onto
  another item to reorder, or onto empty space to move it out; folders nest by
  drag and collapse by clicking the folder row. A drop-indicator line marks the
  insertion point while dragging (absolute; no layout shift). DMs show a
  **pins-only** tree (their lone general channel isn't surfaced).
- Clicking a pinned note **opens it over the chat window** (a `NoteEditor`
  overlay with a close ✕), so notes — channel rules, D&D sheets, co-working docs
  — live in the chat context. `ChatSidebar` emits `open-note`; `ConversationPage`
  loads notes on unlock and renders the overlay.

### Chat folders + pins (v4) — as built

Chat folders are a **separate namespace** from note folders, **per conversation**
and **personal** (stored in the org blob under `chat[convId]` —
folders/itemFolder/itemOrder), so they don't touch the shared channel list or
note payloads. They group both channels and pinned notes. Channel
**create/rename/delete** stay server-side (managers); the **arrangement**
(folders, order) and **pins** are personal — pinning a note into a chat does
**not** share it (sharing is v5). See
[notes.md](notes.md#folders--organization-v4) for the shared org-blob mechanism.

`:emoji:` shortcodes (the same custom/7TV set as chat) render in channel names,
note titles, and folder names via the `EmojiText` component; unicode emoji typed
as glyphs pass through.

### Not yet built (v4 follow-ups)

- Renaming the general channel (extra channels rename/reorder/delete; the general
  channel is fixed).

## v5 — Private channels (as built)

A channel is now either **open** or **private**:

- **Open** (default, the general channel, and every pre-v5 channel) — encrypted
  with the **conversation key** and visible to all conversation members, exactly
  as in v4.
- **Private** — has its **own key + explicit membership + epochs**, mirroring the
  conversation key machinery at the channel level. Only its members can read it.
  Private-from-creation: an open channel can't be retroactively privatised (you
  create a new private channel instead), so a channel never mixes conv-key and
  channel-key messages.

### Data model (server)

- `channels.private` flag. **`channel_members`** `(channel_id, user_id,
  sealed_key, epoch, joined_at)` holds the current-epoch sealed channel key per
  member; **`channel_keys`** `(channel_id, user_id, epoch, sealed_key)` keeps
  every epoch for back-scroll — the same shape as `conversation_members` /
  `conversation_keys`.

### Routes / access

- `POST …/channels` accepts `private:true` + `members:[{userId, sealedKey}]` (a
  sealed channel key per initial member; must be ⊆ conversation members and
  include the creator).
- `POST …/channels/:id/members` (grant) and `DELETE …/channels/:id/members/:uid`
  (revoke) re-key the channel: a new epoch sealed to the (remaining/expanded)
  members; `history:'share'` also seals prior epoch keys to a joiner. Revoking
  deletes the target's keys — they can't read future messages (prior plaintext
  they held is a documented boundary).
- A private channel is **only included in a member's conversation payload**;
  message/read/reaction access is gated on channel membership, and fan-out
  targets the channel's members (not the whole conversation).

### Client

The chat store keeps a `channelKeys` cache (channelId→epoch→key) unsealed from the
conversation payload. Private-channel messages/reactions encrypt/decrypt with the
channel key at the channel epoch; open/general channels use the conversation key.
Actions: `createPrivateChannel`, `grantChannelMember`, `revokeChannelMember`.
`ChannelModal` has a "Private channel" toggle + member picker; private channels
show a lock icon and a Manage-members dialog (`ChannelMembersDialog`).

### Not yet built (v5 follow-ups)

- A chat-sidebar **"share folder"** that bulk-grants every note + private channel
  in a chat folder to chosen participants in one action.
- A **grant-on-pin** prompt (offer to grant participants when pinning a note).
