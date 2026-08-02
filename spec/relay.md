# Relay — wire protocol & state inventory (v8)

> **Status: as built.** The relay is now the **only server** — the legacy
> all-in-one Fastify app (passkey auth, sessions, notes/chat/friends REST, admin,
> SPA serving) has been deleted, along with the browser client it served. What
> remains is `buildRelayApp`: `/api/relay/*`, the KT auditor alias, and a health
> probe. Device auth, directory + KT roots, sealed-sender mailbox + live-delivery
> WS, registration + friend-invite redemption, DM + group blobs, signed
> group state, voice signaling/SFU and the **content proxies** are implemented;
> the endpoint shapes below are as-built. **Not built:** client-side push
> registration (the send path exists; nothing subscribes), the satellite-link
> session (D12), and clients for the GIF and link-preview proxies — all in
> [roadmap.md](roadmap.md). The **emote** proxies do have a client: the Rust
> core consumes both (see
> [local-store.md](local-store.md#emoji-on-device-the-used-emoji-cache)).

## Posture

The relay is transient plumbing: **zero user content at rest**. It holds
ciphertext only until delivery is acknowledged, never learns message senders
(sealed-sender, D6), and never sees plaintext, CRDT structure, note content, or
media. Everything it *does* persist is enumerated below — nothing else may be
added without updating this inventory and [security.md](security.md).

It also stores **no key material, wrapped or otherwise**. The one carve-out from
that rule — the password-wrapped master key held for cold-start recovery — was
[removed](roadmap.md#escrow--removed) on 2026-07-27, so there is nothing on a
relay that any amount of offline work could turn into an account.

The one deliberate exception to "sees nothing" is the **content proxies**: to
keep the *client's* IP away from Klipy, 7TV and arbitrary link targets, the relay
makes those outbound requests itself, so at proxy time it sees a search term or a
URL (bound to a device token). Nothing about it is stored except the cached emote
image bytes. That trade is the whole point of the surface and is spelled out
under [Content proxies](#content-proxies-privacy-not-features) below.

**Deployment.** The relay runs as a **standalone process**
(`buildRelayApp` / `npm run relay:start`, entrypoint `server/src/relay-index.ts`).
There is no static file serving and no frontend of any kind: the security headers
are registered in API-only mode, and because the process never emits HTML its CSP
is only a floor (`default-src 'none'` and friends) — the policy that defends the
app is the **native webview's**
([security.md](security.md#the-native-webviews-csp)). It is
**operator-controlled** via the relay CLI (`npm run relay -- create-invite |
list-devices | revoke-device | status | prune`), which acts directly on the
database: there is no in-app admin account and no admin route. The two identity
commands (`init-identity`, `rotate-online-key`) are the exception — they
deliberately run on the **operator's own machine** and never open the database at
all. A relay **will not start** until an identity bundle has been installed — see
[*Relay identity*](#relay-identity-an-offline-root-and-an-online-signing-key).

## State inventory

### Durable (survives restart; the complete list)

| State | Table | Contents | Why it must persist |
|---|---|---|---|
| Account directory | `users`, `relay_directory` | `handle → per-relay identity + sealing pubkey (Ed25519/X25519)`, created via registration | The key directory (D5); handle uniqueness |
| Key-transparency log | `relay_kt_roots` | signed, hash-chained epoch roots over the directory (AKD sidecar or interim Merkle) | D5 — inclusion/consistency proofs, self-audit, gossip |
| Device records | `relay_devices` | `id` (= b64url SHA-256 of the device pubkey), owner, device pubkey, optional name, created-at, `revoked` | Relay auth (D4b), mailbox fan-out per device |
| Auth challenges | `relay_challenges` | single-use nonces; deleted on use, only valid for 2 min, and rows older than 10 min are swept on every new challenge | Replay-free device auth |
| Delivery-token verifiers | `relay_verifiers`, `relay_group_verifiers` | `hash(delivery token)` per recipient account; one per group | Sealed-sender send authorization (D6) |
| Group-state records | `relay_group_state` | signed `{groupId, version, members[], roles[], channels[]}` docs | Group authority (D14); fan-out needs the member list |
| Invites | `relay_invites`, `relay_registration_invites` | one-time friend invites and operator registration invites (token **hash**, expiry, used-by) | Invite-only reach (D4b) |
| Pending friend bindings | `relay_register_pending_friend` | one-shot `new account → inviter`, consumed by the first authed call | Completes the D4b handshake for invite signups |
| Push subscriptions | `push_subscriptions` | Web Push `(endpoint, p256dh, auth)` per **account** | Content-free wake for an offline device (D7) |
| Relay trust anchor | `relay_root` | the **public** half of the relay's offline root key — one row, and **no private-key column** ([below](#relay-identity-an-offline-root-and-an-online-signing-key)) | What clients pin; verifies every delegation |
| Online signing keys | `relay_online_keys` | every online keypair the root has delegated to, by monotonic `version`, with the root-signed delegation; superseded rows keep the public half and lose the private one | Signs KT roots; old public halves still verify old roots |
| Identity bundle | `DATA_DIR/relay-identity.json` | the file the operator copies in: root **public** key + online keypair + delegation. Ingested at boot, idempotently, and left in place ([below](#setup-the-identity-is-generated-off-the-relay-and-shipped-as-a-bundle)) | How an identity gets onto a relay without ever generating one there |
| Relay-local secrets | `relay_local_secrets` | named random HMAC keys that are not an identity (today: the emote capability key) | Emote URLs must survive an online-key rotation |
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

**And, structurally: the relay's ROOT private key.** Not "not stored today" — it
never exists on the relay at any point. It is generated on the operator's
machine, printed once, and kept out of the bundle the relay ingests; `relay_root`
has no column it could occupy, `parseIdentityBundle` refuses a bundle carrying a
field named like one, and no module on the serving path imports a function that
can mint a delegation ([below](#relay-identity-an-offline-root-and-an-online-signing-key)).
That is what makes a full compromise of this server survivable rather than
terminal.

## Auth (D4/D4b)

Two layers, per D4: the **device token** authenticates *fetching* (mailbox reads,
acks, blob GETs, directory writes, content proxies); **sending is deliberately
unauthenticated** except for the delivery-token capability, so the relay never
links an envelope to a sender account (D6 sealed-sender; the residual IP
correlation is documented there).

- `POST /api/relay/auth/challenge` → `{ nonce }` (32 random bytes, single-use,
  max age 2 minutes).
- `POST /api/relay/auth/token` `{ pubKey, nonce, signature }` where the signature
  covers `nonce|relayIdentityFingerprint` — the **root** fingerprint, so it is
  unchanged by an online-key rotation (binds the proof to *this* relay — no
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
  layer; multi-device pairing (D8) is unbuilt ([roadmap.md](roadmap.md)), and
  relay-held escrow — the former cold-start route — has been
  [removed](roadmap.md#escrow--removed). **So there is no route onto a second
  device at all**: the CLI can list and revoke devices, and nothing can add one.

## Relay identity: an offline root and an online signing key

**The problem this solves.** The relay signs a key-transparency (KT) root every
time its directory changes, so *some* private key must live on the server. Until
2026-08-02 that was the same single key clients pinned, which made a server
breach terminal: the attacker signs forged KT roots with the very key every
client trusts, and the operator cannot revoke the anchor *using* the anchor.
There was also no legitimate way to rotate — a changed fingerprint is (correctly)
refused by every pin.

The fix is the certificate-authority shape: a **root** whose private half never
touches the relay, and an **online** key it delegates to.

| | Root | Online |
|---|---|---|
| Lives | operator's password manager, off the server | `relay_online_keys` on the relay |
| Signs | exactly one kind of statement: a **delegation** | KT roots (everything the relay signs) |
| Clients | **pin** it (`identityFingerprint`, invites' `relayFp`) | trust it only via a valid delegation |
| Breach | not reachable from the server | costs the online key; revoked by a new delegation |

A relay breach now costs an online key the operator revokes with one command,
instead of the identity of every account on the relay.

### The delegation record

A root-signed statement naming the current online key. Served in `/info` as:

```json
{ "version": 2, "onlineKey": "<raw Ed25519, standard base64>",
  "issuedAt": 1785649144381, "notAfter": 1817185144381,
  "signature": "<Ed25519 by the ROOT, standard base64>" }
```

The **signed bytes** are a pipe-delimited string, not the JSON (no
canonicalization to get wrong — the same convention as `kt-root|{root}|{prev}`):

```
accord-relay-delegation|v1|{rootFingerprint}|{onlineKey}|{version}|{issuedAt}|{notAfter}
```

UTF-8, no trailing newline, Ed25519 (pure). `rootFingerprint` is
`base64url(sha256(raw root pubkey))`; `onlineKey` is the raw key in **standard**
base64; the three numbers are decimal integers (timestamps in milliseconds).
`server/src/relayIdentity.ts` is the single implementation.

Three properties are deliberate:

- **`accord-relay-delegation|v1` is a domain separator no other relay signature
  shares.** KT roots sign `kt-root|…`, device auth signs `{nonce}|{fingerprint}`.
  A signature made in one context can never be read as a statement in another.
- **The root fingerprint is inside the signed bytes**, so a delegation is bound
  to the root that issued it and cannot be replayed onto another relay.
- **`version` is a monotonic anti-rollback counter** (only ever increases). The
  relay refuses to install a version that does not exceed every already-signed
  one, and clients must refuse a delegation older than the highest they have
  seen. Without that, an attacker who kept a revoked online key replays its
  still-validly-signed old delegation to put itself back in charge.

`notAfter` is a real deadline: clients refuse an expired delegation. The default
lifetime is 365 days (`--days` to change it), the relay warns in its log from 30
days out, and `relay -- status` shows the remaining time. **The tradeoff, stated
plainly:** an operator who loses the root private key keeps a working relay until
the delegation expires and then cannot renew it — every account must re-register
elsewhere. The alternative (delegations that never expire) means a delegation an
operator has lost control of is honored forever, which is exactly the failure the
split exists to bound. Expiry wins; losing the root key is documented as
unrecoverable in [DEPLOY.md](../DEPLOY.md).

### Rotation, and why old KT roots still verify

`rotate-online-key` runs **on the operator's machine**, like `init-identity`: it
mints a fresh keypair at `version + 1`, signs the delegation with the root key
supplied on stdin, and writes a new bundle. Installing it is the same "copy the
file, restart" as the first one. When the relay ingests it, it **NULLs the
private half of every superseded row** in the same transaction, so a later breach
cannot steal a key the relay no longer needs. The pinned fingerprint does not
move — a rotation must not look like a relay substitution.

Roots signed before a rotation would fail under the new key, so each row of
`relay_kt_roots` records the `key_version` that signed it, `/info` serves the
whole `delegations` array (ascending, all root-signed), and a verifier checks
each root against the delegation its `keyVersion` names
(`ktAudit.ts::keysFromDelegations`). A root naming a version no delegation covers
does not verify.

### Setup: the identity is generated off the relay, and shipped as a bundle

**The decision that shapes this feature: identity generation never runs on the
relay.** An earlier iteration ran `init-identity` on the server and printed the
root key there. That is strictly better than auto-minting, but it still puts the
root private key in a server process's memory and in that box's terminal
scrollback — and it made the *convenient* path the one where the anchor touched
the server, which is how defaults decide what people actually do. So the command
was moved off the relay entirely, and the artifact it produces became the
interface between the two machines.

`init-identity` is **pure key generation**: no database, no `DATA_DIR`, no
network, no relay. An operator runs it on a laptop that has never seen the relay.

```sh
npm run relay -- init-identity          # writes ./relay-identity.json
```

It mints the root and the first online keypair, signs delegation v1, writes the
**bundle** below, and prints the ROOT PRIVATE KEY once — to the terminal, never
to a file.

```json
{ "format": "accord-relay-identity", "formatVersion": 1,
  "rootPubKey": "<raw Ed25519 root PUBLIC key, standard base64>",
  "rootFingerprint": "<base64url(sha256(rootPubKey))>",
  "onlineKey": { "pubkey": "<raw, base64>", "privkey": "<pkcs8 DER, base64>" },
  "delegation": { "version": 1, "onlineKey": "…", "issuedAt": …, "notAfter": …,
                  "signature": "…" } }
```

The bundle is **everything the relay may hold, and nothing else**. There is no
root-private-key field, and `parseIdentityBundle` *refuses* a bundle carrying one
under any of the obvious names — the invariant is enforced at the door, not left
to convention. It is written mode `0600` (it holds the online private key) and is
gitignored.

**Deploying is: copy the file, start the relay. There is no second command.**
The relay reads `DATA_DIR/relay-identity.json` (or `RELAY_IDENTITY_FILE`) at
boot, verifies it, and installs it. Re-reading the same bundle on every restart
is a no-op, and dropping a rotated bundle in the same place installs the new
delegation on the next restart.

**The bundle is left in place after ingest, deliberately.** Deleting it would buy
no confidentiality — it holds no secret the database does not already hold, since
the online private key must live on the relay for KT roots to be signed at all,
and the root private key was never in it — while breaking two things operators
really do: re-create the container against the same volume, and mount the bundle
read-only. Deleting it is safe once the relay is up; keeping it is also safe.

What the relay does with a bundle it will not accept:

| Situation | Behavior |
|---|---|
| No bundle, no installed identity | **refuses to boot**, naming the command and the exact path it looked at |
| Bundle's delegation not signed by the bundle's root, or tampered | refuses to boot |
| Bundle's online private key isn't the delegated key | refuses to boot |
| Bundle rooted at a **different** key than the installed one | refuses to boot — that is a relay substitution, and the anchor may not silently move. A genuinely new relay uses a fresh `DATA_DIR` |
| A **different** delegation at a version already installed | refuses to boot — the root would be equivocating |
| Delegation **older** than the installed one | logs a warning and ignores it (anti-rollback); the relay keeps serving the newer one |
| Same delegation already installed | no-op (the ordinary restart) |

`init-identity` refuses to overwrite an existing bundle file, because that would
mint a *new root* — the fingerprint every client has pinned. `--force` is the
explicit opt-in; `--if-missing` makes it a quiet no-op and exists for test
harnesses (`playwright.config.ts`, the L2 relay harness), not production.

Rotation is the same shape:

```sh
npm run relay -- rotate-online-key --in relay-identity.json < root-key.txt
```

It reads the bundle being replaced (which gives it both the current version and
the root public key to check the supplied private key against — a wrong key fails
here rather than producing a bundle the relay would reject), mints the next
online keypair, signs `version + 1`, and writes the new bundle. An operator who
no longer has the old bundle passes `--current-version N` instead, read off
`GET /api/relay/info`. It refuses a version that does not move forward.

The root key is read from **stdin or `ACCORD_RELAY_ROOT_KEY`, never a flag** —
argv is visible to every process on the box and lands in shell history — and is
used to sign one delegation and dropped.

**The property to check by inspection:** after setup, nothing on the relay's disk
can mint a delegation. `relay_root` has exactly three columns (`id`, `pubkey`,
`created_at`) and no column the root private key could go in;
`server/test/relayIdentity.test.ts` asserts that against the live schema and
scans every byte under `DATA_DIR` — database, WAL, and the bundle file — for the
key in both text and raw form, after a rotation as well as after setup.

**Operators without a checkout** (deploying from the published image) get the
same single route, because `npm run relay` resolves through
`server/bin/relay.mjs`: TypeScript source via tsx in a checkout, the built
`server/dist` in the image, where `src/` and devDependencies are pruned away.

```sh
docker run --rm -v "$PWD:/out" ghcr.io/jtrobinson1993/notes \
  npm run relay -- init-identity --out /out/relay-identity.json
```

## Pinning the relay identity (as built)

The relay publishes its identity at `GET /api/relay/info` as
`{ identityFingerprint, identityPubKey, delegation, delegations }`.
**The first two are not independent:** `identityFingerprint` is
`base64url(sha256(raw root key))` (`relayAuth.ts::fingerprintB64url`) while
`identityPubKey` is the raw Ed25519 **root** key in **standard** base64 — the
encodings are asymmetric and the client checks them rather than assuming. The
fingerprint is what the account's per-relay identity is derived from
([accounts-and-crypto.md](accounts-and-crypto.md)) and what invites carry.

Since the split above, `identityPubKey` is the **root** key: it verifies
delegations and nothing else. **KT root signatures verify against
`delegation.onlineKey`**, after the delegation itself has been verified against
the pinned root.

Three checks run in the Rust core, in this order
(`relay_client::verified_identity` + `delegation.rs` + `lib.rs::connect_to_relay`).
None substitutes for another, and **the order is part of the design**: a relay
whose fingerprint is not the one we are anchored to is refused as an impostor
before its delegation is looked at, so an attacker cannot turn a substituted
relay into a milder "malformed delegation" complaint.

1. **Binding — always, on every connect and register, no exceptions.**
   `relay_fingerprint(identityPubKey)` must equal `identityFingerprint`, or the
   connection is refused before a single authenticated byte
   (`RELAY_IDENTITY_INVALID`). Without this a hostile relay serves the *genuine*
   fingerprint — so every pin still matches and the account keeps its derived
   identity and contact ids — alongside an **attacker** identity key, and then
   signs its own forged directory with the key the client happily verifies roots
   against. Every `contact_verdict` would come back `Verified`. Pinning the
   fingerprint alone cannot see this; only the binding can.

2. **Pinning — the identity must be the one we are anchored to.** The anchor, in
   order of authority:
   - an **invite's `relayFp`**, when the flow has one. It reached the user
     out-of-band through the human invite channel, so it is the only anchor the
     relay did not supply. It is passed through `registerViaInvite` →
     `relay_register` and checked *before* the account is created, and again at
     `relay_invite_redeem` (an invite for a different relay is refused, because a
     transparency log only proves something about the relay it belongs to).
   - the **stored pin** — `relay.identity.<baseUrl>` in the vault (per account),
     written on first successful contact and compared on every connect
     afterwards. On an account that predates the setting, the single existing
     `relays` row supplies the anchor instead, so an upgrade does not re-TOFU.
   - **nothing**, on genuine first contact: the identity is pinned then.

   A disagreement is a hard failure — refuse the connection, raise the hard
   `kt:alarm` (`relay-identity-changed`, same banner as a KT equivocation), and
   surface `RELAY_IDENTITY_CHANGED`. **Never a silent re-pin**, and never
   swallowed by the reconnect path's best-effort silence.
3. **Delegation — the pinned root must vouch for the key that signs the log**
   (`src-tauri/src/delegation.rs`). Once the root is anchored it is a
   trustworthy verifier, so the client walks the published chain with it:
   - every member of `delegations` must verify under the pinned root, and their
     `version`s must be **strictly increasing in the order served** (two records
     at one version would be the root equivocating about which key is in force);
   - `delegation` must be the last/highest member of that chain, so a relay
     cannot advertise a fresh delegation while serving roots under a chain that
     never mentions it;
   - it must not be past `notAfter`;
   - its `version` must be **≥ the highest this account has already accepted**,
     and if it is *equal*, it must name the same `onlineKey`.

   The result is a `DelegatedKeys` — a version→key map, and the **only** value
   in the client a KT-root signing key can be obtained from. That is a type-level
   guarantee, not a convention: `kt::signed_root_epoch`,
   `kt::gossiped_root_is_signed` and `kt::contact_verdict` take a
   `DelegatedKeys`, so there is no way to reach them with the pinned root itself
   or with a key the relay served loose. `relay_client::kt_signing_keys()`
   deliberately replaced the old `relay_identity_pub()` accessor rather than
   sitting beside it.

   Failures are hard, with their own alarm reasons and catalogued codes:
   `RELAY_DELEGATION_INVALID` / `relay-delegation-invalid` for a missing,
   malformed, forged, tampered, mis-chained or expired delegation, and
   `RELAY_DELEGATION_ROLLBACK` / `relay-delegation-rollback` for a version that
   went backwards or equivocated. They are kept apart because they mean different
   things to the user: the first reads as a misconfiguration and often is, the
   second is an attack in progress.

   **Where the high-water mark lives:** in the pin itself. `RelayPin`
   (`lib.rs`, setting `relay.identity.<baseUrl>` in the **per-account vault**)
   carries `delegation_version` + `delegation_online_key` next to `fp` and
   `identity_pub`, because it is the same kind of fact — something about this
   relay that only ever gets stricter. It is read by `relay_anchor` *before* the
   connect and written by `pin_relay_identity` *after* a successful one, with
   `max()`, so a refused connection never advances it and a rotation can never be
   talked back down. Nothing the relay says can raise it; only an accepted
   connect can.

`store::upsert_relay` is the backstop behind that: the `relays` row's
`identity_fp` and `our_identity_pub` are **write-once** (only `url` may change, a
relay moving host). It used to `DO UPDATE SET identity_fp = excluded.identity_fp`
— i.e. the local record of *who this relay is* was an echo of the last connect. A
mismatch now errors (`StoreError::RelayIdentityChanged`) and leaves the row
untouched, so an account whose pin somehow never got written still fails closed
on the next drain or send.

**The residual, stated plainly: TOFU is not the same as anchored.**
`registerOnRelay(relayUrl, code?)` — a public relay, or an operator-seeded one
where the operator hands out a bare registration code — carries **no
fingerprint**, so its first contact is trust-on-first-use. A TOFU-pinned relay is
protected against *later* substitution; it is **not** protected against a relay
that is hostile from the very first connection, which can simply present a
consistent identity of its own. Closing that means the fingerprint travelling
with the registration code (the invite flow already does this) — see
[roadmap.md](roadmap.md#operator-registration-codes-carry-no-relay-fingerprint).

**What rotation does and does not cover.** Rotating the **online** key is a
normal, one-command operation that pinned clients accept without a re-pin
(above) — no alarm, no re-verification, nothing the user sees. Only a bad
delegation signature, a rolled-back version, or a changed **root** is an alarm.
Rotating the **anchor** — the root itself — still has no path: a changed
fingerprint is refused, correctly, and the signed "moved-to" record that would
carry an anchor change or a host move
([roadmap.md](roadmap.md#multi-relay--cross-relay-contact-continuity-d4c)) is
unbuilt. So a lost root private key, or a relay that must move host, still means
new accounts.

**Residual: revocation is forward-looking, not retroactive.** A revoked online
key still validates roots *stamped with its own superseded version*, because the
client resolves each root against the delegation its `keyVersion` names — which
is exactly what keeps pre-rotation epochs verifiable, and what the reference
auditor does (`ktAudit.ts::keysFromDelegations`). So an attacker who kept a
stolen v1 key can still produce a root that a client accepts as v1-signed. What
this costs them is real, though: they no longer hold the server, so they must
also be a network attacker able to defeat TLS to deliver it, and the rollback
check stops them re-installing v1 as *current*. Closing the remainder means
requiring `keyVersion == current`, which would make every root published before
a rotation unverifiable until the next directory change — a live availability
break in exchange for a defence-in-depth gain. **Not taken; flagged as the open
tradeoff.** If it is ever taken, the relay must re-sign and re-publish its
current root on boot after a rotation.

A second residual sits next to it: the high-water mark is *this client's* memory,
so an account that has not connected since the rotation still has a floor of v1
and would accept the genuine v1 delegation. Ordinary revocation freshness,
bounded today only by `notAfter`. Both are tracked in
[roadmap.md](roadmap.md#online-key-revocation-is-forward-looking-and-only-for-clients-that-saw-it).

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
  delegation, delegations, apiVersion: 2, registrationMode }`. Public and
  unauthenticated: it is the pinned-identity handshake surface (UI-4 shows the
  name), and it carries the whole trust chain in one round trip —
  `identityPubKey` is the pinned **root** key, `delegation` is the current
  root-signed delegation naming the online key that verifies KT root signatures,
  and `delegations` is every delegation this root has issued (ascending), which a
  verifier needs for roots published before a rotation.
  `registrationMode` tells onboarding whether to demand an invite before showing
  the signup form. The client checks the fingerprint against the key, the
  delegation against the key, the delegation's version against the highest it has
  seen, and the fingerprint against its anchor before going any further — see
  [*Pinning the relay identity*](#pinning-the-relay-identity-as-built).
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

## Account bootstrap — the relay holds no key material

There is **no escrow and no cold-start path.** `PUT /api/relay/escrow`,
`POST /api/relay/escrow/kdf` and `POST /api/relay/escrow/fetch` existed until
2026-07-27 and have been [removed](roadmap.md#escrow--removed) along with the
`relay_escrow` table: a permanently stored, password-wrapped MK is an offline
brute-force target and contradicts the zero-at-rest posture. A route test asserts
all three now 404, so the surface cannot creep back unnoticed.

**Boot drops the table, blobs included.** Removing the schema definition only
stops *new* rows; a relay upgraded across the removal would keep every blob it
already held — on disk and in every backup, still crackable offline, and no
longer usable by any client. Since that is precisely the liability the removal
retires, `openDb` runs an idempotent `DROP TABLE IF EXISTS relay_escrow` next to
the other boot migrations. It is a no-op on a relay that never had escrow, and
`server/test/db.migrations.escrow.test.ts` pins both that and the fact the drop
takes no neighbouring relay table with it.

Consequently a device can reach an account **only** by having been the device
that registered it. Adding a second device needs pairing
([roadmap.md](roadmap.md#device-pairing--history-transfer-d8)), which is unbuilt
and launch-blocking; note that pairing must also solve *device enrolment*, since
a new device's signing key is in no `relay_devices` row and `auth/token` would
answer `401 unknown or revoked device`.

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
- `GET /api/relay/kt/roots?since=epoch` → `{ relayFp, delegations, roots }`,
  where each root carries `{ epoch, rootHash, prevRootHash, signature, timestamp,
  keyVersion }`. `keyVersion` names the delegated online key that signed it, and
  `delegations` rides along so an auditor can verify the whole chain from this
  response plus the pinned root key. Also aliased at
  `GET /.well-known/accord/kt-roots` for third-party auditors. See
  [key-transparency.md](key-transparency.md).
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
  defaults to 7 days, capped at 14. That fingerprint is **used**, not decorative:
  it anchors the invitee's first connection to the relay and is re-checked at
  redeem ([above](#pinning-the-relay-identity-as-built)).
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
`HMAC(capSecret, "emote:"+id)`, where `capSecret = HMAC(relay_local_secrets
['emote-capability'], "accord:emote-capability:v1")` — its own random 32-byte
secret, minted on first use and stable across restarts so minted URLs and
year-long browser cache entries survive a reboot. It is deliberately **not**
derived from a signing key: rotating the online key must not silently 403 every
cached emote URL, and a signing key should not double as an HMAC key. Comparison is `timingSafeEqual`. **Only the authed search endpoint mints
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

**Who calls these.** Both emote endpoints have a client: the Rust core proxies
search through `emote_search` (so the device token stays off the IPC boundary)
and fetches image bytes through `emote_get`, caching them in the vault's
size-bounded used-emoji store —
[local-store.md](local-store.md#emoji-on-device-the-used-emoji-cache). Two
consequences worth knowing on the relay side:

- The core fetches images with its **device token**, using a placeholder `sig`
  segment — the "either credential" branch the image route already implements,
  and the reason it exists. Only `<img src>` loads (the picker rendering search
  results) use the real capability.
- The core treats a result's `url` as **untrusted**: it accepts only a
  site-relative `/api/relay/emote/<sig>/<id>.webp` for the emote being
  described and re-joins it onto the pinned relay base, and it re-enforces the
  1 MiB image cap against the streamed body. A relay that returned a 7TV CDN
  link would otherwise undo the proxy entirely.

**GIFs and link previews still have no client.** Nothing fetches either, and
the recipient-side host allowlist those features require is in
[roadmap.md](roadmap.md).

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
  `register` (20/min), `invites/check` (30/min), blobs, and each content proxy
  (the tighter escrow buckets went with the routes). These are identity-free
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
