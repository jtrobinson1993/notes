# Profiles & names

How a person is named in the app: a public **handle** the relay knows, and an
**end-to-end-encrypted display name** only contacts see. Bio and avatar belong
to the same profile, but their storage and distribution are **not built yet**
— the editor UI is ahead of the plumbing (see [Bio & avatar](#bio--avatar)).

## Handle vs. display name

Identity is split in two so a relay can route and label accounts without ever
learning a real name. There is **no username** — see the invariant in
`CLAUDE.md`.

- **Handle** — a public `Word#1234` label (e.g. `Otter#0421`) from a curated
  animal/nature word list plus a four-digit discriminator. Unique per relay,
  plaintext, **relay-visible**, and the name shown to anyone who is not a
  contact. Assigned at registration: the signup screen offers generated
  candidates with a re-roll and the client sends the chosen one; the relay
  validates it against the same generator (`isValidHandle`) and claims it,
  reissuing a fresh one if it is somehow taken. A handle is never typed, so the
  word is always from the vetted list.
- **Display name** — the friendly name a contact sees. Chosen at signup
  (required), stored **only inside the encrypted vault**, and delivered to a
  friend end-to-end encrypted. The relay never sees it.

**Changing the handle** lives in Settings → Profile: re-roll generated
candidates and claim one via `POST /api/relay/handle`. There is no step-up
re-authentication, because there is no separate login credential to protect —
the unlocked vault *is* the credential. Friends address you by identity key and
delivery token, so a handle change never breaks the friend graph; only what
non-contacts see changes. The relay refreshes the KT root because the directory
is user-keyed and the handle→key mapping moved
([key-transparency.md](key-transparency.md)).

## How the display name reaches a contact

There is no profile server and no profile blob in transit. The display name
travels **inside the sealed friend handshake**:

- On invite redeem, and on the reciprocating friend-confirm, the payload is
  `{handle, displayName, deliveryToken, sealingPub}` (`friend_payload` in
  `message.rs`, `sealFriendAccept` in `nativeInvites.ts`), sealed to the peer's
  X25519 sealing key and signed inside the envelope
  ([accounts-and-crypto.md](accounts-and-crypto.md#the-sealed-envelope-envelopers)).
- The receiving core stores it in `contacts.display_name` in the local
  encrypted store, and the friends list renders `display_name || handle`.

So the name is E2EE in the strict sense — the relay only ever forwards
ciphertext — but it is a **one-shot at friending time**, not a live profile.

**Unbuilt, stated plainly:** editing your display name afterwards updates only
your own device. There is no update message, so existing friends keep the name
they were told at friending. A profile-update envelope (and the key rotation
that goes with revoking access to it) is future work —
[roadmap.md](roadmap.md).

## Bio & avatar

Settings → Profile has a working editor: a bio (500 characters) and an avatar
picker that opens `AvatarCropper` — a square crop frame with drag-to-pan and
zoom — re-encoding the crop client-side to a **256² WebP data URL**
(`lib/avatar.ts`; PNG fallback, 25 MB input cap, explicit messages for
oversized/undecodable files rather than silent failure).

**Neither value is stored or shared.** `useProfileStore().save()` persists only
`profile.displayName`; bio and avatar live in the Pinia store in memory and are
gone on lock or restart, and nothing in the app renders another user's avatar or
bio. Treat the editor as UI landed ahead of its backing: persisting them in the
vault and distributing them to contacts is future work
([roadmap.md](roadmap.md)). The local store already has the columns this will
use (`contacts.avatar_ref`, `contacts.profile_key_epoch`), currently unused.

## The profile key

The account has a profile key, but in v8 it is **not** a profile-encryption key
sealed to contacts. It is derived from MK and used as the root of the
sealed-sender **delivery token** — see
[accounts-and-crypto.md](accounts-and-crypto.md#delivery-tokens) for its
derivation and for why it does not rotate today. The v1 scheme (a random profile
key sealed per recipient, with an epoch bumped to revoke a contact) does not
exist in the native app; if profile blobs land, they will re-use the same sealed
envelope everything else uses rather than a second mechanism.

## Removed with the legacy stack

These were server-side profile fields and have no v8 equivalent — the server
that stored them is gone:

- **Name color** — the one plaintext profile field the old server kept. Deleted.
  (`ProfileEntry.nameColor` still exists as an always-null field in the Pinia
  store; it is vestigial and nothing sets it.)
- **"Only allow friends to see my profile"** — the friends-only visibility
  toggle and the non-friend key revocation behind it. There is no group
  co-member profile distribution to widen or tighten: reach is friends-gated at
  the relay and profile data does not leave the device.
- **Link previews on/off** — a server-side per-user flag on the legacy stack.
  Native chat does not render link previews yet; when it does, the preference
  must come back as a **local** device setting (the relay's content proxy
  fetches on the client's behalf, so the choice is the reader's alone). Tracked
  in [roadmap.md](roadmap.md), not here.

What *does* exist in Settings → Privacy today is device-local media handling —
click-to-load remote images and video embeds, and pre-upload image
optimization — stored in `localStorage`, unrelated to the profile.

## Not built

- A **contact page**: identity, verification state (SAS), reachability, mutual
  groups, block. There is no `ProfileDialog` or avatar component in the native
  UI; friends are rendered as name + handle + initial.
- **Profile updates after friending** (name, bio, avatar), and the access
  revocation that has to accompany them.
- **Decorations** (animated avatars, profile backgrounds/borders) — still a
  "maybe", still unimplemented.

All of the above live in [roadmap.md](roadmap.md).
