# Editable user profiles (v3.2)

Builds on the v3 display name + name color with a richer, **end-to-end
encrypted** profile: a **bio** and an **avatar**. The server stores only
ciphertext — it never sees a user's bio or avatar.

## Crypto model

Each user has a per-user **profile key** (random 32-byte AES-256-GCM key,
`profileCrypto.ts`). It encrypts a JSON `ProfileData { bio?, avatar? }` blob
(the avatar is a small optimized `data:image/webp` URL embedded whole). The
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
**accepted friends**; group co-members who aren't friends see just the display
name + color. Turning it **off** widens distribution to **group co-members** as
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
  `GET /api/users/:id/profile` → `ProfileView` (display name + color always for a
  related user; the encrypted blob + **my** sealed key when I'm a recipient, else
  `encrypted: null`; **403** with no relationship).

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
