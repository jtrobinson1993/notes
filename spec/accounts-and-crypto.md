# Accounts & cryptography

The identity and key-management foundation everything else builds on. Accord is
a **native app**: every key is generated and held by the Rust core
(`src-tauri/src/`), the UI (`web/src/`) never touches key material — it asks the
core over `invoke()` — and a relay only ever stores ciphertext, wrapped key
blobs, and public keys.

There is no browser client, no server-side session, and no passkey. The v1
passkey/PRF browser account model was deleted, not migrated; see
[Passkeys are not used](#passkeys-are-not-used) and, for the future web client,
[roadmap.md](roadmap.md#d16--a-v8-web-client-deferred).

## The key hierarchy

One derivation tree covers every key. The load-bearing split is **derived**
(re-derivable from MK, so it *cannot* rotate without rotating MK) vs **random**
(independently rotatable) — anything that must rotate on revocation wants to be
random.

```
MK / master seed (random 256-bit, per account — every full device holds it)
│
│  at-rest wrappings (the three ways to open the vault):
│    ← vault key         (random, per device, OS keychain)      [primary]
│    ← Argon2id(password)                                       [portable]
│    ← KDF(recovery code)                                       [break-glass]
│
├─ DERIVED (HKDF-SHA256, domain-separated) — built:
│    ├─ per-relay identity = KDF(MK, domain ‖ relay fingerprint):
│    │    ├─ Ed25519 signing — relay challenges, envelope signatures
│    │    └─ X25519 sealing  — the address inbound envelopes are sealed to
│    └─ profile key = KDF(MK, "accord/profile-key/v1")
│         └─ delivery token = KDF(profile key, "accord/delivery/v1")
│              → sha256 → the verifier the relay stores
│
├─ RANDOM, held in the encrypted local store:
│    ├─ per-group key (one per group, no epochs yet)             built
│    │    └─ group delivery token = KDF(group key, "accord/group-token/v1")
│    ├─ per-file attachment key (fresh per file; the key + IV ride
│    │   inside the E2E message payload, never near the relay)   built
│    └─ per-note key (`notes.note_key`) — the column exists but is
│        unused: notes are local-only until relay sync lands     unbuilt
│
└─ Per-device (random, OS keychain, never leaves the device) — built:
     ├─ device Ed25519 key — signs relay challenges → short-lived token
     └─ SQLCipher key — the local database at rest
```

**Not built** (and deliberately absent from the tree above rather than described
as if present): per-conversation *epoch* keys — a DM is a sealed box per message
to the recipient's derived sealing key, and a group has one long-lived key with
no rotation; the **preview key** for rich push previews; the **backup export
key**. All three are in [roadmap.md](roadmap.md).

Files: `keys.rs` (wrap/unwrap, domain constants, recovery-code format),
`vault.rs` (the three unlock paths, delivery token), `identity.rs`
(per-relay identities), `envelope.rs` (the sealed envelope), `attachment.rs`
(per-file keys).

### Why the profile key is derived, not random

The design called for a random, MK-wrapped profile key so it could rotate. As
built it is **derived from MK** (`Vault::delivery_token()` derives it on first
use and caches it in the `profile.key` setting inside the encrypted store).

The reason is multi-device reach: every device of an account must present the
*same* delivery token, or a friend who reaches one device silently fails to
reach another. There is no device-to-device key sync yet (D8 pairing is
unbuilt), so a random per-device value would diverge. Derivation makes the token
identical on every device — including one that arrives with an empty store —
with no distribution step at all. A regression test in `vault.rs` pins exactly
that: the token is `KDF(KDF(MK, profile), delivery)`, a pure function of MK, so
any device holding MK computes the same value without being told it.

The cost is that rotation is no longer free: rotating means writing a new random
value into `profile.key` *and* getting it to the account's other devices, which
is the same machinery D8 provides. Until then the profile key never rotates —
see [Revocation](#revocation).

## Creating an account

Signup happens in order, and the ordering is deliberate: the **local vault**
exists before any relay does, so the user is given their recovery code before a
network call can fail.

1. **Local.** `vault_create(password)` generates MK, the vault key and the
   SQLCipher key, writes the three wrapped copies, and returns the recovery
   code, which the UI shows once behind an explicit "I saved my recovery code".
2. **Identity.** The user picks a handle from generated `Word#1234` candidates
   (never typed, so the word is always from the vetted list) and a required
   display name. The display name is stored only in the encrypted vault — see
   [profiles.md](profiles.md).
3. **Relay.** Onboarding registers the account and enrolls this device's key on
   a relay, by redeeming a friend invite or with a relay address plus an
   optional operator registration code. The relay assigns/claims the handle and
   returns a device token. See [relay.md](relay.md#registration-account-creation).

An account with no relay yet is a real state: the vault unlocks and the gate
routes to onboarding rather than the app (`nativeVault.ts`).

**A second device cannot be added at all today.** Relay-held escrow — the one
cold-start path — was removed
([roadmap.md](roadmap.md#escrow--removed)), and pairing, which replaces it, is
unbuilt ([roadmap.md](roadmap.md#device-pairing--history-transfer-d8)). An
account therefore lives only on the device that created it, and losing that
device loses the identity
([security.md](security.md#total-device-loss-is-unrecoverable-by-design)).

## Unlocking: the vault (`vault.rs`)

The vault is either `uninitialized`, `locked`, or `unlocked` (decided by whether
`vault.meta.json` exists and whether the store is open). Unlocked means: the
SQLCipher database is open and MK is in the core's memory. `lock()` drops both;
MK is `Zeroizing`, so it is wiped rather than left in a freed allocation.

**At rest**, MK exists only as three wrapped copies in `vault.meta.json`, a
plaintext sidecar next to the database. Every field in it is either a public
parameter (the Argon2id salt and cost) or MK encrypted under a secret the file
does not contain — so the sidecar holds no secret of its own. A test pins the
exact field set, because anything added there is published to whoever can read
the disk. Sidecars written before escrow was removed carry an extra `escrow`
object of auth-key hashes; the field is simply ignored on load (a test covers
that those vaults still open on all three paths), and it is dropped the next
time the file is rewritten.

Wrapping is uniform: `HKDF-SHA256(ikm = secret, info = domain)` → AES-256-GCM
with a fresh 12-byte nonce. The three domains are
`accord/mk-wrap/{vault-key,password,recovery}/v1`, so a blob wrapped for one
path can never be opened by another (tested).

- **Keychain (primary).** A random per-device *vault key* in the OS keychain
  wraps MK. `initGate()` tries this silently on launch, so the normal case is
  the app just opening. Biometric/Secure-Enclave gating of the keychain item is
  **not** implemented — see [roadmap.md](roadmap.md#smaller-deferred-items).
- **Password (portable).** Argon2id (m ≈ 19 MiB, t = 2, p = 1, 32-byte output,
  16-byte random salt) over the account password. Memory-hard because the input
  is low-entropy. A **16-character minimum** is enforced in the signup UI
  (`NativeGate.vue`); nothing but the client can enforce it, because the
  password never leaves the device.
- **Recovery code (break-glass).** 160 random bits, base32, printed as eight
  groups of four. Normalization strips separators and upper-cases, so the code
  can be typed back with any spacing. High entropy, so it feeds HKDF directly —
  no slow KDF needed. Shown exactly once, at signup.

Keychain items live under service `dev.accord.app` as `sqlcipher-key`,
`vault-key` and `device-key`, each suffixed with a short hash of the account's
data directory. That namespacing is what makes **multi-account** safe: each
account is a separate data dir with its own vault, MK, device key and store, so
two accounts on one machine share no key material (`accounts.rs`; see
[native-app.md](native-app.md)).

**Re-lock policy** is per device, stored in the vault: `relock.policy` is
`stay` (default) or `on-idle` with `relock.idleMinutes` (default 15). With
`stay`, the OS lock screen is the boundary — there is no forced inactivity lock.
`nativeVault.ts` owns the timer and, on lock, also stops the mailbox drain
(without MK there is nothing to open envelopes with).

**No password reset, and no remote login.** Both the password and the recovery
code are *local* keys: they unwrap MK from this device's sidecar. Neither is a
credential any server can check, so neither opens an account on a device that
does not already hold it. Lose every device and the account is gone — nobody,
including a relay operator, can decrypt it
([security.md](security.md#total-device-loss-is-unrecoverable-by-design)). The
recover screen says exactly this rather than offering a dead end.

There is **no "change password" flow** yet: changing it means re-wrapping MK
under the new Argon2id secret. Unbuilt — [roadmap.md](roadmap.md).

## Domain-separated derivation

Every derivation — and the one signature prefix — is namespaced, so no output
can be substituted for another (`keys.rs`, `identity.rs`, `envelope.rs`):

| Domain | Purpose |
| --- | --- |
| `accord/mk-wrap/vault-key/v1` | MK under the keychain vault key |
| `accord/mk-wrap/password/v1` | MK under Argon2id(password) |
| `accord/mk-wrap/recovery/v1` | MK under the recovery code |
| `accord/profile-key/v1` | the account profile key, from MK |
| `accord/delivery/v1` | delivery token, from the profile key |
| `accord/group-token/v1` | group delivery token, from the group key |
| `accord/relay-id/ed25519/v1` ‖ fp | per-relay signing key |
| `accord/relay-id/x25519/v1` ‖ fp | per-relay sealing key |
| `accord/envelope/v1` | envelope content key from the ephemeral ECDH |
| `accord/envelope-sig/v1` | signature domain inside the envelope |

The auth/wrap split matters: a secret handed out as a *capability* — a delivery
or group token the relay checks — is derived under an auth domain, never a wrap
domain, so possessing one can never unwrap anything.
(`accord/auth/{password,recovery}/v1` were the escrow fetch keys and are gone
with it.)

## The sealed envelope (`envelope.rs`)

Everything sent to another user reduces to one primitive. The outer envelope
— all the relay holds — is `{v, eph, nonce, ct}`: an ephemeral X25519 keypair,
ECDH against the recipient's per-relay sealing key, HKDF-SHA256, AES-256-GCM.
The inner plaintext carries `{kind, payload, senderIdentityPub, sig, sentAt}`:
the sender's identity certificate rides **inside** the ciphertext, and `sig`
covers `kind|payload`, so a member replaying history later cannot forge content.

Any unlocked device re-derives its sealing key from MK, so it can open anything
sealed to that identity — there is no per-device key exchange to get wrong.
Groups use the symmetric variant under the shared group key (one envelope for
all members). Unknown major versions surface as `UnknownVersion` and the caller
buffers the raw bytes for a later app version rather than dropping them.

## Per-relay derived identities (`identity.rs`)

Each relay sees a **distinct identity keypair derived from the one master seed**
and that relay's pinned fingerprint, so independent relays **cannot collude to
correlate** the same user — chosen over presenting one shared key everywhere.
Handles are minted per relay anyway, so "same handle everywhere" was never on
offer. Derivation is deterministic, which is what lets any device holding MK
re-appear as the *same* user with nothing else — the property pairing will rely
on ([roadmap.md](roadmap.md#device-pairing--history-transfer-d8)).

To authenticate, the device signs the relay's challenge: the relay issues a
random nonce, the device signs `nonce ‖ relay-fingerprint` with its **device
key** (not the identity key), and gets a short-lived bearer token back. Binding
the relay's own fingerprint into the signed payload is what stops a malicious
relay replaying your signature to a different relay. See
[relay.md](relay.md#auth-d4d4b).

**Two independent layers, deliberately.** Vault unlock is local and
user-facing; the relay token is network-level and invisible. The token refreshes
on the *device key*, which lives in the keychain and is readable while the vault
is locked, so the relay connection survives a locked vault and queued traffic
keeps arriving — you re-unlock only to *read*.

A DM's conversation id is likewise derived, not carried: `dm:` + SHA-256 over
the two identity keys in sorted order, so both sides compute the same id with no
exchange, and a message always lands in *my DM with that sender* rather than
wherever the payload claims.

## Delivery tokens

The profile key is the reach root: `delivery token = KDF(profile key,
"accord/delivery/v1")`. The recipient registers `sha256(token)` as a
**verifier** with the relay (`PUT /api/relay/verifier`, device-token authed, so
only your own devices can rotate it); a sender presents the **token** and the
relay compares digests in constant time before queueing the envelope. The send
route takes no device token at all — the capability is the only credential —
so the relay cannot link an envelope to a sender account. The sender's identity
rides inside the sealed envelope, where only the recipient sees it.

**Granularity: one shared token per recipient**, not one per friend, so the
relay never learns your friend count. The accepted cost is that revoking one
friend means rotating the profile key and re-issuing to everyone else
(O(friends) sealed messages — Signal's model); blocks are rare and friend counts
are modest. Groups use the analogous group token derived from the shared group
key: every member derives the same pair, and any current member may register the
verifier (a non-member gets a 403).

## There is no cold start

A password or a recovery code alone has **nothing to decrypt** on a fresh device
— MK is random and every identity derives from it — so a brand-new device cannot
reach an existing account by any means the app offers. This is the current
state, and it is deliberate.

Escrow used to fill the gap: the relay stored the password-wrapped and
recovery-wrapped MK plus public Argon2id parameters, and a fresh device fetched
it by handle. **It was removed on 2026-07-27** — the reasoning, and the removal
inventory, are in [roadmap.md](roadmap.md#escrow--removed). In short: a
permanently stored blob wrapped under one human-chosen password is an offline
brute-force target and a standing at-rest liability on a relay whose whole
posture is zero-at-rest, and it only ever bought what pairing buys better
whenever any device survives. The relay now stores no key material of any kind.

What follows from that, and must not be softened anywhere in the UI:

- **The gate offers no "Log in".** A first run can only sign up. `NativeGate.vue`
  states plainly that an existing account cannot be pulled onto a new device
  yet; tests assert both the absent affordance and the wording.
- **Losing every device loses the identity, permanently** — an accepted design
  constraint, not a gap
  ([security.md](security.md#total-device-loss-is-unrecoverable-by-design)).
- **Pairing is therefore launch-blocking**
  ([roadmap.md](roadmap.md#device-pairing--history-transfer-d8)), together with
  the offline encrypted backup export for the no-surviving-device case.

## Revocation

Two named tiers, so neither the UI nor this document ever oversells what
revocation covers.

- **Tier 1 — "revoke a lost device"** (the realistic case: lost or stolen but
  locked; keychain and SQLCipher intact). Stop honoring the device, and rotate
  everything it could decrypt: the profile key (re-issuing delivery tokens to
  every remaining friend), every group key it held, every shared-note key.
  Content it already decrypted is compromised regardless — it held plaintext.
- **Tier 2 — "identity compromise"** (a device taken while *unlocked*). The
  attacker holds MK itself, so they can re-derive the per-relay identity keys —
  the one thing rotation cannot fix — and could sign a fraudulent key-rotation
  attestation. Recovery is a **new seed, a new identity, and re-verification
  with contacts out of band**. Tier 1 must never be presented as covering this.

**What is actually built:** the relay half of tier 1. An operator revokes a
device with the relay CLI (`revoke-device <id>`), and every device-token-authed
route re-checks the `revoked` flag on each request — so a revoked device loses
mailbox fetch and blob access **immediately**, not merely when its 15-minute
token expires. Its mailbox queue also stops receiving fan-out
(`activeRelayDeviceIds` filters revoked devices).

**What is not built:** all of the rotation. `friend_remove` only drops the local
friend row and addressing; it does not rotate the profile key, so an unfriended
contact keeps a *working* delivery token and can still queue envelopes to you.
Group-key rotation on member removal, note-key rotation, and any Devices screen
to trigger a revocation are likewise absent. Blocking is therefore not yet a
security boundary — it is a local hide. See
[roadmap.md](roadmap.md#revocation--blocking-fan-out); nothing here should be
described to a user as revocation until that lands.

## Passkeys are not used

No part of the app registers, stores, or verifies a WebAuthn credential today.
The v1 model wrapped MK with the **PRF extension** output; native shells make
PRF unreliable (it is broken on Linux), which is why the account model moved to
keychain/password/recovery in the first place. A **password is therefore
mandatory** at signup: absent reliable PRF it is the only universal
MK-decryption factor, and the recovery code stays break-glass.

Re-scoping passkeys to what they *are* good at — phishing-resistant bootstrap
authentication to a relay, and an opportunistic (never load-bearing) PRF wrap
where PRF genuinely works — is future work, in
[roadmap.md](roadmap.md). No relay route accepts a WebAuthn assertion.

## What the relay stores about an account

Identity-adjacent state only; the full inventory is in
[relay.md](relay.md#state-inventory).

- `users` — id, role, and the public `handle` (`Word#1234`). No username, no
  email, no password, no display name.
- `relay_devices` — one row per enrolled device: its Ed25519 public key,
  content-derived id, optional label, and a `revoked` flag.
- the **directory** — the account's per-relay identity + sealing public keys,
  published under its handle and logged in key transparency
  ([key-transparency.md](key-transparency.md)).
- the **delivery verifier** — `sha256(delivery token)`, and nothing about who
  holds it.

**No key material.** Since escrow was removed the relay holds nothing —
wrapped or otherwise — that could reconstruct an account.
