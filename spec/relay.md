# Relay — wire protocol & state inventory (v8 design)

> **Status: v8 design — not yet built.** This is the concrete protocol behind
> the v8 decisions in [roadmap.md](roadmap.md) (D4, D4b, D5, D6, D7, D11, D14,
> D15). It is a *lean retention profile* of today's server — same Node/Fastify
> codebase, same `/api` conventions — not a new service. Endpoint shapes here
> are the design intent; exact payloads get finalized at build and this file
> becomes the as-built reference.

## Posture

The relay is transient plumbing: **zero content at rest**. It holds ciphertext
only until delivery is acknowledged, never learns message senders
(sealed-sender, D6), and never sees plaintext, CRDT structure, note content, or
media. Everything it *does* persist is enumerated below — nothing else may be
added without updating this inventory and [security.md](security.md).

## State inventory

### Durable (survives restart; the complete list)

| State | Contents | Why it must persist |
|---|---|---|
| Account directory | `handle → per-relay identity pubkey (Ed25519/X25519)`, created via invite redemption | The key directory (D5); handle uniqueness |
| Key-transparency log | AKD/CONIKS append-only tree over the directory + signed epoch roots | D5 — inclusion/consistency proofs, self-audit, gossip |
| Device records | per-account device pubkeys, push tokens + platform, creation time | Relay auth (D4b), mailbox fan-out per device, push (D7) |
| Delivery-token verifiers | `hash(delivery token)` per recipient account; group verifiers per group | Sealed-sender send authorization (D6) |
| Escrow blobs | password-wrapped MK, recovery-code-wrapped MK, domain-separated auth-key hashes | Cold-start recovery (D15) |
| Group-state records | signed `{groupId, version, members[], roles[], channels[]}` docs | Group authority (D14); fan-out needs the member list |
| Invites | one-time friend invites, relay-join invites (token hash, expiry, used-by) | Invite-only reach (D4b) |
| Relay identity | the relay's own signing keypair (pinned by clients via invite fingerprint) | Signs KT roots, tokens, "moved-to" records (D4c) |

### Transient (deleted on ack or TTL)

| State | Lifetime |
|---|---|
| Mailbox queues — opaque envelopes per recipient *device* | until that device acks; **TTL ~30 days** (D6) |
| Blob store — encrypted attachment chunks | until all recipients ack; **TTL 14 days**, 100 MB/file cap (D6) |
| Satellite link sessions (D12) | session-scoped; opt-in "keep linked ≤ N days" |
| Rate-limit counters | in-memory, per IP |

### Never stored

Message/note/media plaintext *or* post-ack ciphertext, sender identity on any
envelope, the friendship graph (verifiers are per-recipient, not per-edge),
profile contents, read state, tokens (only hashes), voice media (SFU forwards
frames, D7).

## Auth (D4/D4b)

Two layers, per D4: the **device token** authenticates *fetching* (mailbox
reads, acks, blob GETs, device management); **sending is deliberately
unauthenticated** except for the delivery-token capability, so the relay never
links an envelope to a sender account (D6 sealed-sender; the residual IP
correlation is documented there).

- `POST /api/auth/challenge` → `{ nonce }` (random, single-use, short expiry).
- `POST /api/auth/token` `{ devicePubKey, signature }` where the signature
  covers `nonce ‖ relayIdentityFingerprint` (binds the proof to *this* relay —
  no cross-relay replay, D4b) → `{ token, expiresInSec }`. Token TTL is short
  (minutes); devices re-sign silently. **Revoking a device = stop honoring its
  challenges**; its live token dies within the window (no blocklist state).
- **Device enrollment:** a new device key is registered either (a) sealed-MK
  pairing from an existing device (D8 — the existing device signs an "add
  device" record), or (b) account bootstrap after escrow auth (below).

## Escrow & account bootstrap (D15)

- `PUT /api/escrow` (device-token auth) — upload/update the wrapped-MK blobs +
  auth-key hashes. Same blobs on every relay the user joins.
- `POST /api/escrow/fetch` `{ handle, authProof }` — `authProof` is a passkey
  WebAuthn assertion (where supported) **or** the domain-separated
  password/recovery auth key. Heavily rate-limited per handle + IP (the blobs
  are brute-force targets; see D15). Success also permits enrolling the new
  device key (bootstrap).

## Mailbox (D6, D11)

- `POST /api/mailbox/send` `{ deliveryToken, recipient, envelope }` — **no
  device token.** Relay checks `hash(deliveryToken) == verifier`, stamps
  `relayTs` (ms; enforced non-decreasing per relay), and copies the envelope to
  each of the recipient's device queues. The envelope is opaque: sender
  identity + content signature live *inside* the ciphertext (D6/D11).
- `POST /api/mailbox/send-group` `{ groupToken, groupId, envelope }` — one
  upload; relay fans out to every member device queue per the group-state
  record, acking/deleting per device.
- **Ephemeral flag** (typing/presence): `ephemeral: true` envelopes are
  delivered only to currently-connected devices — never queued, never stored.
- `GET /api/mailbox` (device token) → batch of `{ queueId, relayTs, envelope }`.
- `POST /api/mailbox/ack` `{ queueIds[] }` → delete. Delivery is
  **at-least-once**; clients dedupe by the sender-assigned message id (D11).
- **WebSocket** `GET /api/relay/ws` (device token in the `Authorization`
  handshake header — native client, so no cookie/Origin dance; a bearer token
  has no CSRF surface) for **live delivery**. It carries a single content-free
  nudge `{type:'mail'}` sent to a recipient's connected devices the moment a send
  enqueues — the connected device then runs its normal REST `fetch → ack` loop.
  The socket only removes poll latency: the REST mailbox stays authoritative
  (hold-until-ack), so a dropped/missed nudge is harmless (the next poll or
  reconnect drains the queue). The nudge reveals nothing beyond "you have mail,"
  which the owning device already learns by polling. A content-free push (D7)
  fires for queued envelopes when the device is fully offline.
- **Client lifecycle:** the relay session lives only in the client process, so a
  cold start redials the remembered relay URL on **vault unlock** (drains need
  the MK-derived sealing key) and re-arms the `relay:mail` listener; re-lock
  stops the listener (the Rust WS task keeps running by design).

## Blob store (D6)

Attachment ciphertext travels through the relay; the per-file key + which
message it belongs to ride inside the E2E envelope and never reach the relay.
Filesystem-backed with a high-entropy 256-bit blobId (capability). **DM-first as
built** — group blobs (one blob, many recipients, GC on all-ack) wait on the
group-state record (D14) for the member set.

- `POST /api/relay/blobs` — **upload authorized by the recipient's delivery
  token** (`x-delivery-token` + `x-recipient-handle` headers; body is raw
  `application/octet-stream` ciphertext, 32 MB cap). Like mailbox/send this is
  sealed-sender-compatible: the uploader proves it may send to the recipient but
  stays sender-anonymous. Uniform 401 for a bad handle/token. → `{ blobId, size }`.
- `GET /api/relay/blobs/:id` — **download, device-token gated to the recipient**
  (`recipientUserId == device.userId`) plus the unguessable id; unknown/not-yours/
  malformed id → uniform 404. Streams the ciphertext.
- `POST /api/relay/blobs/:id/ack` (device token, recipient only) — delete now;
  otherwise swept at **TTL 14 days**.

*Follow-ups:* chunked/resumable + ranged transfer for large media (first cut is
whole-blob); group blobs on D14.

## Directory & key transparency (D5)

- `GET /api/directory/:handle` → `{ identityPubKey, ktInclusionProof, epoch }`.
- `GET /api/kt/roots?since=epoch` → signed epoch roots (consistency checking);
  also aliased at `GET /.well-known/accord/kt-roots` for third-party auditors.
- Clients self-audit their own binding on every connect and piggyback latest
  seen roots on E2E traffic (gossip, D5); mismatch ⇒ hard key-integrity alarm.
- `GET /api/relay/info` → `{ name, identityFingerprint, apiVersion, limits }`
  (self-declared name per UI-4; limits = blob cap, TTLs). A relay changing URL
  publishes a **signed `moved-to` record** here, verified against the pinned
  key (D4c).

## Group state (D14)

The group's authority record is a **client-signed, opaque JSON string**
`{ groupId, version, members:[{ identityPubKey, role }], channels[] }`. The relay
does **ordering + availability, not trust**.

- `PUT /api/relay/groups/:id/state` `{ record, adminSignature }` (device token) —
  accepted iff (a) `adminSignature` over the exact `record` string verifies
  against a key the **current** record calls `owner`/`admin` (**genesis is
  self-authorizing** against its own admin set), and (b) the record's `version`
  **strictly exceeds** the current one (anti-rollback). `version` lives *inside*
  the signed record, so it can't be swapped. → `{ version }`; `403` if not
  admin-signed, `409` if not newer, `400` on malformed/`groupId` mismatch. A
  plain `member` can't self-escalate: a record naming themselves admin still
  needs a *current* admin's signature.
- `GET /api/relay/groups/:id/state` (device token) → `{ record, version }`.
  **Member-gated**: the requester's directory identity key must appear in
  `members`; non-members and unknown groups both get a **uniform 404** (a
  non-member can't even learn the group exists).

Clients independently verify the full signature chain. **Fine-grained role rules**
(e.g. only the owner may remove admins; channel ACLs) are client-enforced — the
relay only guarantees monotonic, admin-signed versions. `groupId`s must be
unguessable (a genesis PUT for an unknown id just creates that group).

## Invites (D4b)

The friend-invite token is a **one-time delivery capability** (built). Redeeming
it drops exactly one sealed "friend-accept" envelope — carrying the invitee's
own delivery token, sealed E2E to the inviter (whose identity/sealing pubkeys the
invitee reads from the directory) — into the inviter's mailbox; reciprocation is
then an ordinary sealed send. The relay stores only `hash(token)`; the token
itself is shared out-of-band (QR / link) and never seen by the relay.

- `POST /api/relay/invites` (device token) — mint `{ tokenHash, expiresInSec? }`
  → `{ expiresAt }`. The self-describing invite payload (relay hint + relay key
  fingerprint + token) is assembled client-side. TTL capped at 14 days.
- `POST /api/relay/invites/redeem` `{ token, envelope }` — **capability only, no
  device token**: requiring the invitee's device token would let the relay link
  "X redeemed Y's invite" = a social-graph edge, defeating sealed-sender (D6).
  Atomically claims the unused, unexpired invite (one-time; double-redeem races
  resolve to one winner), enqueues `envelope` to the inviter's device queues +
  live-nudges, and returns `{ relayTs }`. Uniform 401 for unknown/expired/used
  (tokens are high-entropy, so this leaks nothing).
- `POST /api/relay/invites/check` `{ token }` → `{ valid }` — non-consuming
  validity check, rate-limited as a cheap oracle guard.

*Relay-join invites* (redeem creates the account + claims the handle) remain a
future variant layered on this same one-time-token mechanism.

## Push (D7)

- `PUT /api/devices/:deviceId/push` `{ platform, token }` (device token).
- Relay sends **content-free pings only**, via its own web-push/VAPID keys and
  the first-party APNs/FCM credentials from `.env` (D7; gateway is post-v8).

## Web satellite (D12)

- QR link handshake: the browser opens an unauthenticated WS, displays the
  ephemeral pubkey QR; the native device approves (SAS) and the relay upgrades
  the WS to a **satellite session** bound to that device's account, with the
  session TTL from D12. The native device's device list can kill it
  (`DELETE /api/devices/:satelliteId`).
- Satellite history requests are **device-to-satellite envelopes over the
  relay** (WhatsApp-Web model) — the relay just forwards; nothing is stored.

## Voice (unchanged from v6)

Signaling + mediasoup SFU + STUN/TURN as built ([voice.md](voice.md)), with
auth moving from session cookie to the device token. No at-rest data.

## Abuse & limits (D6)

- **IP-based rate limiting** on `send`, `blobs`, `escrow/fetch`, `auth`, and
  invite redemption — identity-free volumetric caps; no sender-based limiting
  exists (there is no sender).
- Send requires a valid delivery/group token — there is **no stranger-reach
  surface**: revoked token (unfriend/kick → key rotation, D6/D13) = relay
  refuses delivery.

## Envelope versioning

Every envelope carries a leading `{ v: <int>, type: <string> }` header
**inside the plaintext framing** (the relay treats the body as opaque and
never interprets `v` — versioning is client↔client). Rules: minor additions
are backward-compatible optional fields; a client receiving `v` **newer than
it supports** stores the raw envelope, renders a "message from a newer version
— update the app" placeholder, and re-decodes after upgrade (never drops
data). CRDT payloads carry their own `docSchema` — the local-store side of the
same policy ([local-store.md](local-store.md)).

## Explicitly not in the protocol

Federation (relay↔relay anything), server-side search, durable message/media
storage, sender-authenticated sends, per-member group filtering (in-group
blocking is client-side, D6), and any moderation surface (arrives only with v9
public chats, as an opt-in relay feature).
