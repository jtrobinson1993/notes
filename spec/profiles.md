# Editable user profiles (v3.2)

A user's **display name, bio, and avatar** are **end-to-end encrypted** and shown
only to **contacts** — the server stores only ciphertext and never sees any of
them. Everyone else (and the server) sees a public **handle**; name color is the
one piece of plaintext profile metadata the server keeps.

## Handles vs. the display name (v6)

Identity is split into three parts so the server can route and label accounts
without learning real names:

- **Username** — the login credential. Unique, plaintext, **never shown to any
  other user**.
- **Handle** — a public `Word#1234` label (e.g. `Otter#0421`) from a curated
  animal/nature word list (`server/handleWords.ts`, 3–10 chars, no profanity) plus
  a 4-digit discriminator. **Unique, plaintext, server-visible**, and the name
  shown to **non-contacts** (and the server) everywhere a person is surfaced —
  friend requests, members you aren't friends with, share pickers. Generated at
  signup (3 options to pick from; auto-assigned otherwise); changeable in Settings
  (`generateHandleOptions` / `setUserHandle`; `GET /api/handle/options`,
  `PUT /api/handle`, validated by `isValidHandle`). Backfilled for every existing
  account by an idempotent migration.
- **Display name** — the friendly real name, now part of the **encrypted**
  `ProfileData` blob (below). Only **contacts** who hold the sealed profile key
  decrypt it; the server can't read it. The client overlays each contact's
  decrypted name over the handle it received from the server (`profile.hydrate` /
  `displayNameFor`; the chat/friends/voice stores call it). A one-time client
  migration moves any **legacy plaintext** display name into the encrypted blob
  and then clears the server's copy (`PUT /api/profile { displayName: null }`).

The rest of this doc covers the encrypted blob (bio + avatar + display name).

## Crypto model

Each user has a per-user **profile key** (random 32-byte AES-256-GCM key,
`profileCrypto.ts`). It encrypts a JSON `ProfileData { displayName?, bio?, avatar? }`
blob (the avatar is a small optimized `data:image/webp` URL embedded whole). The
profile key is distributed two ways — reusing the chat key machinery, not a
second mechanism:

- **Wrapped under the owner's master key** (`wrapProfileKey`, HKDF info
  `notes:wrap:profile-key:v1`) and stored server-side, so the owner can recover
  and edit their profile on any device.
- **Sealed to each recipient's X25519 public key** (`sealProfileKey`, the same
  ephemeral-static "sealed box" used for conversation keys), so each contact can
  unseal the key and decrypt the blob.

**Rotation = forward secrecy.** A monotonic **epoch** rides with the profile.
When a contact loses access, the owner's client generates a *new* profile key,
re-encrypts the blob, bumps the epoch, and re-seals only to the remaining
recipients (`profile.rotate()`). The lost contact keeps only stale plaintext it
already saw; it can't read future updates. (This mirrors conversation-key epoch
re-keying.)

## Visibility

A **"Only allow friends to see my profile"** setting (default **on**;
`users.profile_friends_only`). With it on, the profile key is only ever sealed to
**accepted friends**; group co-members who aren't friends see just the **handle**
+ color. Turning it **off** widens distribution to **group co-members** as
well. Tightening back to friends-only **immediately revokes** any sealed keys
held by non-friend co-members (`deleteNonFriendProfileKeys`) — they lose the
current blob at once; the next save re-seals to friends only.

## Distribution & revocation

- **On accept / `friend-accepted`:** both sides seal their current profile key to
  the new friend and `POST /api/profile/keys` (no rotation — adding a recipient
  doesn't need a new epoch). Must match the stored epoch.
- **On unfriend:** the server deletes the profile-key rows **both directions**
  (`deleteProfileKeyPair`) so each side loses the other's current blob
  immediately; the unfriending client also **rotates** so future updates stay
  hidden.
- **On update:** recipients receive a `profile-updated` WebSocket frame; the
  client invalidates its cached decryption so the next render re-fetches.

## Server (`db.ts`, `routes/chat.ts`)

- `profiles(owner_id PK, ciphertext, iv, epoch, owner_wrapped_key, updated_at)` —
  the encrypted blob + the MK-wrapped key.
- `profile_keys(owner_id, recipient_id, epoch, sealed_key, PK(owner_id,
  recipient_id))` — the profile key sealed per recipient.
- `users.profile_friends_only` (migration; default 1).
- Routes (all `requireAuth`): `GET /api/profile` now also returns `friendsOnly`;
  `GET /api/profile/data` (owner's own blob + wrapped key, or null);
  `PUT /api/profile/data` (set/rotate the blob + sealed keys — validates every
  recipient is a friend, or a co-member when not friends-only);
  `POST /api/profile/keys` (distribute to a new recipient at the current epoch);
  `PUT /api/profile/visibility` (toggle; tightening revokes non-friend keys);
  `GET /api/users/:id/profile` → `ProfileView` (**handle** + color always for a
  related user; the encrypted blob + **my** sealed key when I'm a recipient, else
  `encrypted: null` — and the real display name lives *inside* that blob; **403**
  with no relationship).
- `users.handle` (unique, indexed; migration backfills all rows). Identity
  helpers `effectiveHandle()` (public name) vs `effectiveDisplayName()` (the
  legacy plaintext, now only returned to the owner for one-time migration).

## Client (`stores/profile.ts`, UI)

- The store holds my profile key in memory only (like conversation keys), my
  decrypted `ProfileData`, visibility, and epoch; it caches other users'
  decrypted profiles by id. It loads on socket connect and resets on lock.
- **Edit:** Settings → Profile has the avatar uploader + bio; Settings → Privacy
  has the visibility toggle. Picking an avatar opens `AvatarCropper` — a square
  crop frame with **drag-to-pan + zoom** (slider/wheel) — and the chosen crop is
  re-encoded client-side to a **256² WebP** (`lib/avatar.ts`; PNG fallback) data
  URL. Failures (oversized input, undecodable file, encoding/canvas errors, or a
  rejected save) surface an explicit message rather than failing silently.
- **View:** `ProfileDialog` (on the reusable `AppModal`) shows a contact's
  avatar + name + bio, opened by clicking a sender's avatar or name in chat.
  `ChatAvatar` renders the decrypted avatar when present, else the initial.

## Deferred

- **Decorations** (animated avatars, profile backgrounds/borders) — the "maybe"
  from the roadmap; not implemented.
- **Rotation when *being* unfriended** by someone else: the server already
  revokes the current blob symmetrically; proactive key rotation on the
  passive side is left for when a dedicated unfriended-notification frame lands.
