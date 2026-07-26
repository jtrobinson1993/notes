# Relay — wire protocol & state inventory (v8)

> **Status: as built.** The relay is now the **only server** — the legacy
> all-in-one Fastify app (passkey auth, sessions, notes/chat/friends REST, admin,
> SPA serving) has been deleted, along with the browser client it served. What
> remains is `buildRelayApp`: `/api/relay/*`, the KT auditor alias, and a health
> probe. Device auth, directory + KT roots, sealed-sender mailbox + live-delivery
> WS, escrow, registration + friend-invite redemption, DM + group blobs, signed
> group state, voice signaling/SFU and the **content proxies** are implemented;
> the endpoint shapes below are as-built. **Not built:** client-side push
> registration (the send path exists; nothing subscribes), the satellite-link
> session (D12), and any client consumer of the content proxies — all in
> [roadmap.md](roadmap.md).

## Posture

The relay is transient plumbing: **zero user content at rest**. It holds
ciphertext only until delivery is acknowledged, never learns message senders
(sealed-sender, D6), and never sees plaintext, CRDT structure, note content, or
media. Everything it *does* persist is enumerated below — nothing else may be
added without updating this inventory and [security.md](security.md).

The one deliberate exception to "sees nothing" is the **content proxies**: to
keep the *client's* IP away from Klipy, 7TV and arbitrary link targets, the relay
makes those outbound requests itself, so at proxy time it sees a search term or a
URL (bound to a device token). Nothing about it is stored except the cached emote
image bytes. That trade is the whole point of the surface and is spelled out
under [Content proxies](#content-proxies-privacy-not-features) below.

**Deployment.** The relay runs as a **standalone process**
(`buildRelayApp` / `npm run relay:start`, entrypoint `server/src/relay-index.ts`).
There is no static file serving and no frontend of any kind: the security headers
are registered in API-only mode (`registerSecurityHeaders(app, config, null)` —
no SPA shell, so no inline-script hashes to thread into the CSP). It is
**operator-controlled** via the relay CLI (`npm run relay -- create-invite |
list-devices | revoke-device | status | prune`), which acts directly on the
database: there is no in-app admin account and no admin route.

## State inventory

### Durable (survives restart; the complete list)

| State | Table | Contents | Why it must persist |
|---|---|---|---|
| Account directory | `users`, `relay_directory` | `handle → per-relay identity + sealing pubkey (Ed25519/X25519)`, created via registration | The key directory (D5); handle uniqueness |
| Key-transparency log | `relay_kt_roots` | signed, hash-chained epoch roots over the directory (AKD sidecar or interim Merkle) | D5 — inclusion/consistency proofs, self-audit, gossip |
| Device records | `relay_devices` | `id` (= b64url SHA-256 of the device pubkey), owner, device pubkey, optional name, created-at, `revoked` | Relay auth (D4b), mailbox fan-out per device |
| Auth challenges | `relay_challenges` | single-use nonces; deleted on use, only valid for 2 min, and rows older than 10 min are swept on every new challenge | Replay-free device auth |
| Delivery-token verifiers | `relay_verifiers`, `relay_group_verifiers` | `hash(delivery token)` per recipient account; one per group | Sealed-sender send authorization (D6) |
| Escrow blobs | `relay_escrow` | wrapped-MK payload, public KDF params, domain-separated auth-key hashes | Cold-start recovery (D15) |
| Group-state records | `relay_group_state` | signed `{groupId, version, members[], roles[], channels[]}` docs | Group authority (D14); fan-out needs the member list |
| Invites | `relay_invites`, `relay_registration_invites` | one-time friend invites and operator registration invites (token **hash**, expiry, used-by) | Invite-only reach (D4b) |
| Pending friend bindings | `relay_register_pending_friend` | one-shot `new account → inviter`, consumed by the first authed call | Completes the D4b handshake for invite signups |
| Push subscriptions | `push_subscriptions` | Web Push `(endpoint, p256dh, auth)` per **account** | Content-free wake for an offline device (D7) |
| Relay identity | `relay_identity` | the relay's own Ed25519 keypair (pinned by clients via invite fingerprint) | Signs KT roots and "moved-to" records (D4c); also keys the emote capability |
| Emote image cache | `DATA_DIR/emoji-cache` | 7TV WebP bytes, ≤4000 files, ≤1 MiB each, oldest evicted | Serves emotes from our own origin so no client ever hits 7TV's CDN |

**Legacy schema still on disk.** `db.ts` continues to *create* the v1 tables
(`credentials`, `sessions`, `notes`, `messages`, `conversations`, `profiles`, …).
No relay route reads or writes any of them, so on a fresh relay they stay empty —
but an in-place upgrade of a v1 deployment keeps that old at-rest data (passkey
credentials, note and message ciphertext, profile blobs) in the same SQLite file
until it is dropped. Dropping the dead schema is
[cleanup work](roadmap.md#cleanup--what-the-deletion-left-behind); until then the
"zero content at rest" property is true of the *code*, not automatically of an
upgraded operator's disk.

### Transient (deleted on ack or TTL)

| State | Lifetime |
|---|---|
| Mailbox queues (`relay_mailbox`) — opaque envelopes per recipient *device* | until that device acks; **TTL 30 days** (D6) |
| Blob store (`relay_blobs`, `relay_group_blobs` + `DATA_DIR/relay-blobs`) | until the recipient acks (DM); **TTL 14 days**, 32 MB/file cap |
| Rate-limit counters | in-memory, per IP |

### Never stored

Message/note/media plaintext *or* post-ack ciphertext, sender identity on any
envelope, the friendship graph (verifiers are per-recipient, not per-edge),
profile contents, read state, tokens (only hashes), voice media (SFU forwards
frames, D7), and anything from the content proxies except cached emote bytes —
GIF queries, previewed URLs and emote searches are proxied and logged nowhere
(the failure logs deliberately record the error, never the query).

## Auth (D4/D4b)

Two layers, per D4: the **device token** authenticates *fetching* (mailbox reads,
acks, blob GETs, directory writes, content proxies); **sending is deliberately
unauthenticated** except for the delivery-token capability, so the relay never
links an envelope to a sender account (D6 sealed-sender; the residual IP
correlation is documented there).

- `POST /api/relay/auth/challenge` → `{ nonce }` (32 random bytes, single-use,
  max age 2 minutes).
- `POST /api/relay/auth/token` `{ pubKey, nonce, signature }` where the signature
  covers `nonce|relayIdentityFingerprint` (binds the proof to *this* relay — no
  cross-relay replay, D4b) → `{ deviceId, token, expiresInSec }`. The nonce is
  consumed **before** the signature check, so a failed attempt still burns it.
- The token is a **stateless HMAC** `v1.<deviceId>.<exp>.<mac>` over a
  **per-boot secret**, TTL **900 s**; devices re-sign silently, and a relay
  restart simply forces one re-auth. Because the secret never leaves the process
  there is no token table to leak.
- **Revocation is immediate.** `deviceFromAuthHeader` — the single definition of
  "is this request device-authed", used by every gated route — resolves the token
  to the `relay_devices` row and refuses it if `revoked = 1`. So
  `revoke-device` kills live tokens at once, not merely at the next challenge.
- **Device enrollment** happens only at account registration (below). The
  session-gated `/api/relay/devices` bootstrap endpoints went with the session
  layer; multi-device pairing (D8) is unbuilt ([roadmap.md](roadmap.md)), so today
  the CLI lists/revokes devices and escrow recovery is the only route onto a
  second device.

## Registration (account creation)

The signup surface for a brand-new account + its first device, in one
unauthenticated call. The relay is **operator-controlled** — there is no in-app
admin and **no first-user bypass**. The operator chooses who may register via
`RELAY_REGISTRATION_MODE` (default **`invite`**; only the exact string `public`
opens it):

- **`public`** — anyone may create an account.
- **`invite`** — closed: a valid invite is **always** required (including the
  operator's own first account). Two invite kinds are accepted:
  - an **operator registration invite** — CLI-minted, no inviter, a pure signup
    grant (`relay_registration_invites`, storing only `hash(token)`). This is how
    the operator seeds a fresh relay and lets new people on.
  - a **user friend invite** (D4b, `relay_invites`) — minted in-app by an
    existing user; besides granting signup it also establishes the friendship
    (below).

- `GET /api/relay/info` → `{ name, identityFingerprint, identityPubKey,
  apiVersion, registrationMode }`. Public and unauthenticated: it is the
  pinned-identity handshake surface (UI-4 shows the name, the full public key
  lets anyone verify KT root signatures), and `registrationMode` tells onboarding
  whether to demand an invite before showing the signup form.
- `POST /api/relay/register` `{ pubKey, name?, inviteToken?, handle? }` — creates
  the user (role `member`), enrolls `pubKey` as its first device, and returns
  `{ userId, deviceId, handle, token, expiresInSec }` (a device token, so the
  client is authed immediately — no separate challenge round-trip). Rejects an
  already-enrolled `pubKey` (409, idempotency) and, in `invite` mode, a
  missing invite (403) or an invalid/expired/used one (uniform 401). Rate-limited
  to 20/min. The matched invite (whichever kind) is consumed here. If device
  enrollment somehow fails the just-created user is deleted, so no keyless orphan
  account is left behind.
- `handle` is optional: the native signup screen offers a picker of **generated
  `Word#1234` candidates** (from the shared curated word list — never a typed
  username, so the word is always vetted) with a re-roll, and sends the chosen
  one. The relay validates it (`isValidHandle`) and claims it, reissuing a fresh
  handle if it's somehow taken; an absent/invalid `handle` is simply auto-assigned.
  The account's **display name** (the E2EE name contacts see) is chosen at signup
  too, but stays client-side — the relay never sees it.
- `POST /api/relay/handle` `{ handle }` (device-token authed) changes my public
  handle to another generated candidate: validates it (`isValidHandle` + not
  taken), updates `users.handle`, and refreshes the KT root (the directory is
  user-keyed — the handle comes from the users join, so the identity/sealing keys
  don't move). Friends address me by identity key + delivery token, so a handle
  change never breaks the friend graph; only what non-contacts see by handle
  changes. 400 malformed / 409 taken.
- A **friend** invite additionally doubles as a **friend request** (the
  greenfield "invite your friends" flow): registering with one stashes a
  **one-shot pending-friend** record binding the new account to the inviter. The
  account's first authed call, `POST /api/relay/register/friend-accept`
  `{ envelope }`, claims that record and drops the sealed friend-accept into the
  inviter's mailbox — completing the D4b handshake (the inviter reciprocates a
  friend-confirm the new device drains). One-shot: it can't be replayed to spam
  the inviter. Operator invites and public signups have no inviter (no-op,
  `{ delivered: false }`).

## Escrow & account bootstrap (D15)

- `PUT /api/relay/escrow` (device-token auth) — upload/update the wrapped-MK
  payload (≤8 KB), the **public** KDF params, and the password/recovery auth-key
  hashes. Same blobs on every relay the user joins.
- `POST /api/relay/escrow/kdf` `{ handle }` → the Argon2 salt + cost. Served
  pre-auth because a cold-start device needs the salt to derive its fetch auth
  key, and a salt is not secret. **Anti-enumeration:** a handle with no escrow
  gets a *deterministic pseudo-salt* (`SHA-256("escrow-pseudo|relayFp|handle")`)
  with real Argon2 costs, so a prober can't distinguish registered from
  unregistered accounts. 10/min.
- `POST /api/relay/escrow/fetch` `{ handle, authKind: 'password'|'recovery',
  authKey }` — proves knowledge of the **domain-separated auth key** derived from
  the password or the recovery code (a different HKDF domain than the wrap key,
  so it can't unwrap anything). Uniform 401 for unknown handle / no escrow / bad
  key. Hard-limited to **5/min per IP** because these blobs are offline
  brute-force targets (D15).
  *There is no WebAuthn/passkey path any more* — passkeys died with the browser
  client; password or recovery code are the only two proofs.

**Escrow fetch returns the payload and nothing else — it does not enroll the
recovering device.** `vault_restore_from_escrow` rebuilds the vault (same MK, same
identity) from the wrapped blob, but the device signing key is fresh random per
device, so the restored device's pubkey is in no `relay_devices` row and
`auth/token` answers `401 unknown or revoked device`. Recovery therefore restores
*local* identity, not relay access; closing that needs either enrollment-on-escrow-
proof or device pairing (D8) — see
[roadmap.md](roadmap.md#device-pairing--history-transfer-d8).

The relay accepts `authKind: 'recovery'` and stores a recovery auth hash, but the
client only ever sends `'password'`: the recovery-code cold start is a
server-side capability with no caller.

## Mailbox (D6, D11)

- `POST /api/relay/mailbox/send` `{ deliveryToken, recipientHandle, envelope }` —
  **no device token.** Relay checks `hash(deliveryToken) == verifier` (timing-safe),
  stamps `relayTs` (ms; enforced strictly increasing per relay process), and
  copies the base64 envelope (≤256 KiB) to each of the recipient's non-revoked
  device queues. The envelope is opaque: sender identity + content signature live
  *inside* the ciphertext (D6/D11). Uniform 401 for a bad handle *or* a bad token,
  so the endpoint is not a handle oracle.
- `PUT /api/relay/verifier` `{ verifier }` (device token) — the recipient
  registers/rotates `hash(delivery token)`. Only the account's own devices can.
- `GET /api/relay/mailbox` (device token) → up to 200 `{ queueId, relayTs,
  envelope }`.
- `POST /api/relay/mailbox/ack` `{ queueIds[] }` → delete. Delivery is
  **at-least-once**; clients dedupe by the sender-assigned message id (D11).
- **WebSocket** `GET /api/relay/ws` (device token in the `Authorization`
  handshake header — native client, so no cookie/Origin dance; a bearer token has
  no CSRF surface) for **live delivery**. It carries a single content-free nudge
  `{type:'mail'}` to a recipient's connected devices the moment a send enqueues;
  the device then runs its normal REST `fetch → ack` loop. The socket only removes
  poll latency: the REST mailbox stays authoritative (hold-until-ack), so a
  dropped nudge is harmless. The nudge reveals nothing beyond "you have mail,"
  which the owning device already learns by polling.
- **Offline recipients:** if *no* device is live on the WS, the send fires a
  content-free push (D7) instead. Online devices already got the nudge.
- **Client lifecycle:** the relay session lives only in the client process, so a
  cold start redials the remembered relay URL on **vault unlock** (drains need
  the MK-derived sealing key) and re-arms the `relay:mail` listener; re-lock stops
  the listener (the Rust WS task keeps running by design).

There is **no ephemeral/never-queued envelope class**. Every envelope is queued
and stored until acked or TTL'd, including the ones the client treats as
throwaway (call rings, KT gossip — the client acks them without re-buffering).
Typing indicators and presence do not exist at all in v8; if they arrive they
need a real transient path, because today "ephemeral" would still mean "at rest
on the relay until acked."

## Blob store (D6)

Attachment ciphertext travels through the relay; the per-file key + which message
it belongs to ride inside the E2E envelope and never reach the relay.
Filesystem-backed (`DATA_DIR/relay-blobs`) with a high-entropy 256-bit blobId
(capability), id-allowlisted and `resolve()`-contained to that directory.

- `POST /api/relay/blobs` — **upload authorized by the recipient's delivery
  token** (`x-delivery-token` + `x-recipient-handle` headers; body is raw
  `application/octet-stream` ciphertext, 32 MB cap). Like mailbox/send this is
  sealed-sender-compatible: the uploader proves it may send to the recipient but
  stays sender-anonymous. Uniform 401 for a bad handle/token. → `{ blobId, size }`.
- `GET /api/relay/blobs/:id` — **download, device-token gated to the recipient**
  (`recipientUserId == device.userId`) plus the unguessable id; unknown/not-yours/
  malformed id → uniform 404. Streams the ciphertext. **Ranged/resumable:**
  advertises `accept-ranges: bytes`; honours a single `Range: bytes=start-end`
  (also `start-` and `-suffix`) with `206` + `content-range`, or `416` +
  `bytes */<size>` for an unsatisfiable/garbage range. Clients resume an
  interrupted download from the last received byte (`download_resumable`).
- `POST /api/relay/blobs/:id/ack` (device token, recipient only) — delete now;
  otherwise swept at **TTL 14 days**.

**Group blobs** (built on D14): a member uploads sender-anonymously with the
**group token**, so — like the DM delivery token — the relay can't tell which
member (a device token would leak the sender within the group).

- `PUT /api/relay/groups/:id/verifier` `{ verifier }` (device token) — register
  `hash(group token)`; members all derive the same value from the group key.
- `POST /api/relay/groups/:id/blobs` (`x-group-token` header, octet-stream body)
  → `{ blobId, size }`; uniform 401 on a bad token.
- `GET /api/relay/groups/:id/blobs/:blobId` (device token + **current
  membership** per the group-state record, matched on the requester's directory
  identity key) → ciphertext; non-member/wrong-group/unknown → uniform 404. Same
  ranged/resumable support as the DM download.

*Follow-up:* group blobs are **TTL-GC only** — per-member-ack GC is unbuilt.

## Directory & key transparency (D5)

- `PUT /api/relay/directory` `{ identityPubKey, sealingPubKey }` (device token) —
  publish this account's per-relay keys and cut a new epoch. → `{ epoch }`.
- `GET /api/relay/directory/:handle` → `{ identityPubKey, sealingPubKey,
  rootHash, epoch, proof }`. `proof` is a Merkle **inclusion path** proving the
  returned keys are present under the signed epoch `rootHash` (a binary Merkle
  tree over the handle-ordered directory; verify with `ktMerkle.verifyInclusion`,
  then verify `rootHash`'s signature via the roots endpoint).
  *Interim:* leaves are handle-derived (no VRF label blinding).
  **Full-AKD path (when `AKD_SIDECAR_URL` is set):** the same endpoint returns
  `{ identityPubKey, sealingPubKey, proof, epoch, rootHash, vrfPublicKey,
  kt:'akd' }` where `proof` is an akd **VRF-blinded** inclusion proof — verify
  with `akd_core::lookup_verify` against `rootHash` + `vrfPublicKey`, then check
  the root signature. Directory PUTs publish to the sidecar and its akd root is
  signed + chained into the KT log exactly like the interim root.
- `GET /api/relay/directory/:handle/history` → the key-history proof used by
  self-audit. **AKD backend only**; the interim Merkle KT cannot prove history and
  answers 404.
- `GET /api/relay/kt/roots?since=epoch` → signed epoch roots (consistency
  checking); also aliased at `GET /.well-known/accord/kt-roots` for third-party
  auditors. See [key-transparency.md](key-transparency.md).
- Clients self-audit their own binding on connect and gossip latest seen roots
  over a dedicated envelope kind (D5); mismatch ⇒ hard key-integrity alarm.
- A relay changing URL publishes a **signed `moved-to` record**, verified against
  the pinned key (D4c) — **unbuilt**; `/info` carries no such field yet
  ([roadmap.md](roadmap.md#multi-relay--cross-relay-contact-continuity-d4c)).

## Group state (D14)

The group's authority record is a **client-signed, opaque JSON string**
`{ groupId, version, members:[{ identityPubKey, role }], channels[] }` (≤64 KiB).
The relay does **ordering + availability, not trust**.

- `PUT /api/relay/groups/:id/state` `{ record, adminSignature }` (device token) —
  accepted iff (a) `adminSignature` over the exact `record` string verifies
  against a key the **current** record calls `owner`/`admin` (**genesis is
  self-authorizing** against its own admin set), and (b) the record's `version`
  **strictly exceeds** the current one (anti-rollback). `version` lives *inside*
  the signed record, so it can't be swapped. → `{ version }`; `403` if not
  admin-signed, `409` if not newer, `400` on malformed/`groupId` mismatch. A plain
  `member` can't self-escalate: a record naming themselves admin still needs a
  *current* admin's signature.
- `GET /api/relay/groups/:id/state` (device token) → `{ record, version }`.
  **Member-gated**: the requester's directory identity key must appear in
  `members`; non-members and unknown groups both get a **uniform 404** (a
  non-member can't even learn the group exists).
- `POST /api/relay/groups/:id/send` `{ groupToken, envelope }` — one
  **group-key-sealed** envelope, authorized by the group token (sender-anonymous
  like DM send). The relay fans it out to **every current member's device
  queues** — members are listed by identity key in the D14 record → account →
  devices — and never decrypts (members share the group key). Uniform 401 on a bad
  token; live-nudges recipients.

Clients independently verify the full signature chain. **Fine-grained role rules**
(e.g. only the owner may remove admins; channel ACLs) are client-enforced — the
relay only guarantees monotonic, admin-signed versions. `groupId`s must be
unguessable (a genesis PUT for an unknown id just creates that group).

## Invites (D4b)

The friend-invite token is a **one-time delivery capability**. Redeeming it drops
exactly one sealed "friend-accept" envelope — carrying the invitee's own delivery
token, sealed E2E to the inviter (whose identity/sealing pubkeys the invitee reads
from the directory) — into the inviter's mailbox; reciprocation is then an
ordinary sealed send. The relay stores only `hash(token)`; the token itself is
shared out-of-band (QR / link) and never seen by the relay.

- `POST /api/relay/invites` `{ tokenHash, expiresInSec? }` (device token) →
  `{ expiresAt }`. The **client** generates the token and sends only its hash, so
  the relay never holds a redeemable value. The self-describing invite payload
  (relay hint + relay key fingerprint + token) is assembled client-side. TTL
  defaults to 7 days, capped at 14.
- `POST /api/relay/invites/redeem` `{ token, envelope }` — **capability only, no
  device token**: requiring the invitee's device token would let the relay link
  "X redeemed Y's invite" = a social-graph edge, defeating sealed-sender (D6).
  Atomically claims the unused, unexpired invite (one-time; double-redeem races
  resolve to one winner), enqueues `envelope` to the inviter's device queues +
  live-nudges, and returns `{ relayTs }`. Uniform 401 for unknown/expired/used
  (tokens are high-entropy, so this leaks nothing).
- `POST /api/relay/invites/check` `{ token }` → `{ valid }` — non-consuming
  validity check, rate-limited to 30/min as a cheap-oracle guard.

*Relay-join invites* (redeem creates the account + claims the handle) remain a
future variant on this same one-time-token mechanism.

## Content proxies (privacy, not features)

`server/src/routes/relayContent.ts`, backed by `gifSearch.ts`, `linkPreview.ts`,
`emotes.ts` and `ssrf.ts`. These are the three places the app needs third-party
content, and they live on the relay for **one** reason: **the client's IP must
never reach Klipy, 7TV, or an arbitrary link target.** The relay makes the
outbound request and hands back normalized data. A secondary reason for GIFs: the
Klipy API key stays server-side.

They were part of the legacy all-in-one server; when it was deleted they moved
here rather than being dropped, because a native client with no proxy would be
*less* private than the browser app was.

**Auth model.** Search/metadata endpoints are **device-token gated**, exactly like
the rest of `routes/relay.ts` — an unauthenticated `/og` would be
SSRF-as-a-service, and an unauthenticated GIF proxy burns the operator's Klipy
quota. Each endpoint also gets its **own rate bucket on top of** the global per-IP
limiter, expressed as a fraction of `RATE_LIMIT_MAX` so a relay tuned up or down
scales with it: GIFs and emote search `max/10` (60/min at the default 600), `/og`
`max/20` (30/min — the SSRF surface gets the tightest bucket), emote images `max/1`
(one message can reference many emotes).

### GIF search (Klipy)

- `GET /api/relay/gifs/search?q&pos` and `GET /api/relay/gifs/trending?pos`
  (device token) → `{ results:[{id,title,url,previewUrl,width,height}], next }`.
- `q` ≤100 chars, page clamped to 1..1000, 24 per page. `503` when
  `KLIPY_API_KEY` is unset (GIF search simply disabled), `502` on an upstream
  failure — and the failure log records the error only, **never the query**,
  because a search term is user content.
- The provider is handed `customer_id = SHA-256("klipy:"+userId)[0..16]` — a
  stable pseudonym for their analytics/monetization instead of our real account
  id.
- **Known limit — the GIF bytes are not proxied.** `url`/`previewUrl` point at
  Klipy's CDN, so the *search* is anonymous but rendering a result would let the
  CDN see the viewer's IP (and, for a received message, the recipient's too). Only
  emotes are byte-proxied. A client wiring up the GIF picker must decide between
  proxying the media, accepting the leak, or click-to-load — the same call the
  link-preview image forces.

### Link preview (Open Graph)

- `GET /api/relay/og?url=` (device token) → a `LinkPreview`
  `{ url, title?, description?, siteName?, image? }`. `400` invalid URL or
  non-http(s) scheme, `404` when the page yields nothing worth showing, `502` on a
  fetch failure. URL ≤2048 chars.
- **SSRF hardening (two layers, both required):**
  1. `assertPublicHost()` pre-check per hop — rejects IP literals in private,
     loopback, link-local (incl. `169.254.169.254`), CGNAT, benchmark, TEST-NET
     and multicast ranges; the IPv6 equivalents plus IPv4-mapped, NAT64
     (`64:ff9b::/96`), 6to4 and `::a.b.c.d` embeddings; and the names
     `localhost`, `*.local`, `*.internal`, `*.home.arpa`, `*.in-addr.arpa`,
     `*.ip6.arpa`. An unparseable address is refused.
  2. `publicOnlyLookup` installed as the **undici connect-time DNS hook**
     (`ssrfSafeAgent`), so the IP the socket *actually* connects to is
     re-validated. This is the authoritative guard: it closes the DNS-rebinding
     TOCTOU where a host passes the pre-check with a public record and then
     resolves to `127.0.0.1` for the real request. TLS SNI is preserved, so HTTPS
     still works.
- Redirects are followed **manually** (`redirect: 'manual'`), max 4, and every hop
  re-runs the checks above. Timeouts are budgeted **per hop (6 s) and across the
  whole chain (10 s)**, so N redirects can't stretch one request into N × the hop
  timeout. The response must be `text/html`/`application/xhtml`, is capped at
  **512 KiB** (declared `content-length` *and* a streamed cap), and only the first
  64 KiB is parsed for OG tags. Fields are clamped to 500 chars and HTML entities
  are decoded in a **single pass** so `&amp;lt;` can't double-unescape.
- **Known limit — the preview image is not proxied.** `image` is returned as the
  third-party URL found in the page. A client that renders it directly re-creates
  exactly the IP leak this endpoint exists to prevent, so any consumer must either
  proxy the image through the relay or keep it click-to-load. No client renders
  previews yet; whoever wires it up owns this decision.
- The operator does see which URL a device previewed, at request time. That is
  strictly better than the link target seeing the user's IP, but it is not
  nothing, and it is the reason `/og` is device-authed and given the tightest
  bucket of the four proxies.

### 7TV emotes

The fixed bundled manifest is gone (a committed `defaultEmoji.json` of ~300 ids
refreshed by a script). The relay now proxies **live 7TV search**, so the picker
can offer the whole catalogue instead of a snapshot.

- `GET /api/relay/emotes/search?q&page&limit` (device token) →
  `{ results: [{ id, name, width, height, animated, url }], next }` via 7TV's
  GraphQL API, ordered `TOP`. An **empty query returns the current top emotes** —
  that is the picker's default set, the replacement for the old manifest. `q`
  ≤100 chars, `limit` 1..100 (default 60), page clamped 1..1000, `502` on an
  upstream failure. Results are filtered hard: ids must be 26-char Crockford
  ULIDs, names must match `[A-Za-z0-9_]{2,40}` (they render as `:name:`), and
  duplicate names are dropped.
- `GET /api/relay/emote/:sig/:file` → the WebP bytes, `Cache-Control: immutable`
  for a year.

**Why the image endpoint is authorized differently.** It has to work as
`<img src>`, and an `<img>` cannot send an `Authorization` header. So instead of
the device token it is gated on an **unguessable capability in the path**: `sig`
is the first 22 base64url chars (~132 bits) of
`HMAC(capSecret, "emote:"+id)`, where `capSecret = HMAC(relay identity privkey,
"accord:emote-capability:v1")` — derived, never the identity key itself, and
stable across restarts so minted URLs and year-long browser cache entries survive
a reboot. Comparison is `timingSafeEqual`. **Only the authed search endpoint mints
those URLs**, and a device token is accepted as an alternative credential so the
native core can fetch an image without a search round-trip.

The honest reading of that trade: 7TV ids are public and the emote bytes are
public, so the capability is not protecting confidentiality — it stops a stranger
turning the relay into a general 7TV mirror and filling its disk cache. It is a
**shared, non-expiring bearer value** (the same `sig` for a given emote for every
user of the relay), and it does not identify who fetched it. If an emote ever
needed to be non-public, this scheme would not be the right one.

The cache itself is defensive: ids are ULID-allowlisted and the path is
`resolve()`-contained to `DATA_DIR/emoji-cache`, the upstream response must be
`image/*`, bytes are capped at 1 MiB, and once the directory passes 4000 files the
oldest are evicted down to 90% (checked every 50 writes) — so a client walking the
catalogue can't fill the operator's disk.

The emote image route is the **only** response that opts out of
`Cross-Origin-Resource-Policy: same-origin` (it sets `cross-origin`), because the
native shell's webview origin is not the relay's origin and the `<img>` would
otherwise be blocked.

**No client calls any of these endpoints yet.** The emote registry in
`web/src/lib/emoji/index.ts` is empty at runtime, and nothing fetches GIFs or link
previews. The picker/composer wiring, and the designed-but-unbuilt on-device
**used-emoji cache** (an offline store plus a shared render component that
persists what it renders), are in [roadmap.md](roadmap.md).

## Push (D7)

- `GET /api/relay/push/key` → `{ publicKey }` — the VAPID public key, or `null`
  when push isn't configured (the client then relies on the live WS + polling).
- `POST /api/relay/push/subscribe` `{ endpoint, p256dh, auth }` (device token) —
  stores a Web Push subscription **per account**, not per device.
- `POST /api/relay/push/unsubscribe` `{ endpoint }` (device token).
- The relay sends **content-free pings only** — literally `{"type":"mail"}` — and
  only when no device is live on the WS. Dead subscriptions (404/410) are pruned
  on send. VAPID keys come from `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` or are
  generated once into `DATA_DIR/vapid.json`.
- Transport is **Web Push/VAPID only**. There are no APNs or FCM credentials and
  no push gateway.
- **Nothing subscribes.** No client calls `/push/subscribe`, so the send path is
  dead in practice — registration is entangled with the mobile shell, see
  [roadmap.md](roadmap.md#push-registration-d7) and
  [notifications.md](notifications.md).

## Voice

Signaling + mediasoup SFU + STUN/TURN as built ([voice.md](voice.md)), mounted on
the relay and **device-token authed**:

- `GET /api/relay/voice` — WebSocket signaling (bearer token in the handshake
  `Authorization` header; the socket closes immediately if it doesn't resolve to
  a live device), call-id-scoped frame relay.
- `POST /api/relay/voice/rooms/:callId/{join,transport,transport/connect,produce,consume,leave}`
  — the mediasoup SFU control surface.

No at-rest data; the SFU forwards frames it cannot decrypt (media is E2EE, and the
client now **fails closed** if the webview can't attach the frame transforms).

## Abuse & limits (D6)

- **IP-based rate limiting** everywhere — a liberal global ceiling
  (`RATE_LIMIT_MAX`, default 600/min) plus tighter per-route buckets on
  `register` (20/min), `invites/check` (30/min), `escrow/kdf` (10/min),
  `escrow/fetch` (5/min), blobs, and each content proxy. These are identity-free
  volumetric caps; no sender-based limiting exists (there is no sender).
- Send requires a valid delivery/group token — there is **no stranger-reach
  surface**: revoked token (unfriend/kick → key rotation, D6/D13) = relay refuses
  delivery.
- Body limit 2 MB globally; blob routes raise it to 32 MB for their
  octet-stream bodies; WS frames are capped (`WS_MAX_PAYLOAD`).

## Envelope versioning

Every envelope carries a leading `{ v: <int>, type: <string> }` header **inside
the plaintext framing** (the relay treats the body as opaque and never interprets
`v` — versioning is client↔client). Rules: minor additions are
backward-compatible optional fields; a client receiving `v` **newer than it
supports** stores the raw envelope, renders a "message from a newer version —
update the app" placeholder, and re-decodes after upgrade (never drops data). CRDT
payloads carry their own `docSchema` — the local-store side of the same policy
([local-store.md](local-store.md)).

## Not built

Named here so nobody reads their absence as an oversight; each is described in
[roadmap.md](roadmap.md):

- **The web-satellite / QR link session (D12).** There is no satellite code on
  the relay at all: no link WS, no satellite session, no `DELETE /api/devices/:id`.
  A second client surface arrives with D16, if at all.
- **Multi-device pairing (D8)** and therefore device enrollment beyond
  registration.
- **Client push registration (D7).**
- **Signed `moved-to` relay migration records (D4c).**
- **Per-member-ack GC for group blobs** (TTL only today).

## Explicitly not in the protocol

Federation (relay↔relay anything), server-side search, durable message/media
storage, sender-authenticated sends, per-member group filtering (in-group blocking
is client-side, D6), and any moderation surface (arrives only with v9 public
chats, as an opt-in relay feature).
