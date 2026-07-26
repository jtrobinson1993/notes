# Accounts & cryptography

The identity and key-management foundation everything else builds on. All
encryption/decryption happens **client-side** (WebCrypto + `@noble/curves`);
the server only ever stores ciphertext, wrapped keys, and WebAuthn public keys.

> **Two models live here.** Everything up to "Server-side identity tables"
> describes the **v1 model as shipped in the legacy web app** — passkey/PRF
> wrapping, server sessions, server-side identity tables. **[v8 — the native key
> hierarchy](#v8--the-native-key-hierarchy-as-built)** at the bottom is the
> as-built model for the native client, where keys live in the Rust core and the
> relay holds no session. The v1 *primitives* (sealed box, HKDF domains,
> Argon2id parameters, the recovery-code format) carry over unchanged; the
> *account and unlock model* does not.

## Cryptography model

Priorities: modern, boring, widely supported (Chrome, Firefox-based Zen, Safari).

- **Master key (MK):** random 256-bit, generated client-side at signup. Never
  leaves the client unwrapped. Held in memory for the session (mirrored into
  per-tab `sessionStorage` so an in-tab reload restores it without re-prompting)
  and dropped when the tab/app fully closes or on a manual **Lock**. There is
  **no inactivity auto-lock** — the device's own lock screen is the boundary —
  and MK is deliberately never written to persistent storage, which would expose
  it to XSS at rest.
- **Key wrapping:**
  - *Passkey:* WebAuthn **PRF extension** output → HKDF-SHA-256 → wraps MK
    (AES-256-GCM). One wrapped copy per registered passkey. Passkeys without PRF
    support are rejected at registration with a clear message.
  - *Recovery code:* random 160-bit (base32 in groups of 4) → HKDF → a second
    wrapped copy of MK, plus a separately-derived auth key whose hash the server
    stores for recovery login. High entropy, so no slow KDF needed.
  - *Password (optional fallback / passkey-less path):* for users whose passkey
    can't produce PRF output (e.g. Firefox on Linux) **and for users who can't
    register a passkey at all**. A user-chosen password (**16-char minimum,
    enforced client-side only** — the server never sees it) + a random salt →
    **Argon2id** (`hash-wasm`, m≈19 MiB, t=2, p=1; memory-hard because the input
    is low-entropy, unlike the recovery code) → a third wrapped copy of MK, plus a
    separately-derived auth key whose hash the server stores. Can be added later
    under Settings → Security (requires an unlocked session) **or chosen at signup**
    via the passkey-less path (below); passkey stays the default and the password is
    offered behind "Other options" at signup, as an "alternative method" on the
    login screen, and as "Unlock with password" on the lock screen (an already
    logged-in but locked session, where the handle is taken from the session so
    only the password is asked). `password.ts` holds the derivation;
    `INFO_PASSWORD_WRAP` namespaces the wrap.
- **Per-note key:** random AES-256-GCM key per note, wrapped by MK. Titles and
  bodies both encrypted.
- **Per-user X25519 keypair (sharing / chat):** created at signup via
  `@noble/curves` (portable across browsers that lack WebCrypto X25519). Private
  key wrapped by MK; public key stored server-side as metadata.
- The server stores ciphertext blobs, wrapped keys, and WebAuthn public keys. It
  can never read notes or messages.

### Domain-separated key derivation

HKDF `info` strings keep wrapped/sealed forms from being interchangeable
(`crypto.ts`): `INFO_MK_WRAP`, `INFO_NOTE_KEY`, `INFO_PRIVATE_KEY`,
`INFO_RECOVERY_WRAP`, `INFO_PASSWORD_WRAP`, `INFO_SEAL`, plus `INFO_SETTINGS` for
the encrypted settings blob.

### The sharing / sealing primitive (reused by chat)

Sharing a secret (a note key, a conversation key) to another user is a
**sealed box**: `sealKey(recipientPublicKey, raw)` = ephemeral X25519 keypair +
ECDH + HKDF + AES-256-GCM; `unsealKey(myPrivateKey, myPublicKey, sealed)` on the
recipient. Any unlocked device can recover its X25519 private key from MK, so it
can unseal anything sealed to it. The server stores the opaque sealed blob
per-recipient. v3 chat reuses this verbatim for conversation keys.

## Accounts, auth & distribution (v1, shipped)

- **Install:** Docker; all data in a single mounted volume (SQLite + config).
- **Admin bootstrap** on first run; the admin creates/revokes invite links and
  removes users.
- **Signup via invite:** passkey registration + a one-time recovery code, **or**
  the passkey-less password path (`POST /api/register/password`) for users who
  can't make a passkey — same first-run-or-invite gate, the client generates MK
  and uploads only wrapped blobs (MK wrapped under the Argon2id password key and
  the recovery secret), so a password account still gets a recovery code. Both
  paths live behind "Other options" in the same signup flow (setup + invite). On the password path the handle is chosen on the password step — it is the login username (`handle` + password), so a password manager captures it — and the display name is set after the account is created. An
  invite is **one-time** — `markInviteUsed` records `used_by` on registration, and
  both `register/options` and `register/verify` reject a used/expired token. The
  invite page first calls the **non-consuming** `GET /api/invite/:token` (returns
  only `{ valid }`) and redirects a used/expired/unknown link to **login** rather
  than re-showing the signup flow; a router guard likewise bounces an
  already-signed-in user off `/invite/*` to the app.
- **Login** with passkey; add/remove additional passkeys; **recover** with the
  handle + recovery code (which re-registers a passkey). An optional **password**
  fallback (handle + password, set up in Settings) is offered behind an
  "alternative methods" link, rate-limited per handle like recovery.
- **Changing the handle** (Settings → Security) also changes the **password
  sign-in username**, since the handle *is* that username. A standing amber note
  says so, and the change is **step-up-authenticated for password accounts**:
  `PUT /api/handle` requires the same password auth key as login when
  `password_auth_hash` is set, so someone with an unlocked session can't silently
  change the handle and lock the owner out of password login. The re-auth form
  carries the new handle as the username + the current password, so the browser
  can offer to update the saved login. Passkey-only accounts have no password
  (and their passkey login is handle-agnostic), so they just confirm a warning.
- **No password reset.** Because everything is end-to-end encrypted, there is no
  way to recover an account once the password, all passkeys, *and* the recovery
  code are lost — the user is warned of this at password setup and in Settings →
  Security, and steered toward a password manager + passkey.
- **Sessions:** server session cookie (`notes_session`, httpOnly, SameSite=Lax);
  the cookie is the sha256 of a random token. Mutating `/api/*` requests are
  CSRF-checked against the `Origin` header.

## Multi-device & device linking

### How multi-device works today (shipped)

Every device holds MK in memory after unlock, and every passkey has its own
`wrapped_mk` (`credentials` table), so any registered passkey on any device
unlocks MK independently. Two ways to onboard a new device today:

- **Syncing passkey provider** (iCloud Keychain, Google Password Manager,
  1Password, …): the passkey is already present on the new device — nothing to
  do. The recommended path.
- **Recovery code:** for **device-bound** authenticators (Windows Hello and
  other platform passkeys that don't sync), the new device runs `recover()` —
  the recovery code unwraps MK from `recovery_wrapped_mk`, the device registers
  its own passkey, and the recovery code is rotated. This is the only
  cross-device bridge for a non-syncing authenticator, and each use spends and
  re-issues the code.

### Device linking (not built)

QR + SAS device pairing — adding a device from an already-unlocked one, and
streaming history to it — is **not implemented**. The design (and its security
invariants) lives in [roadmap.md](roadmap.md#device-pairing--history-transfer-d8).
Until it lands, a fresh v8 device re-establishes **identity** from the relay-held
escrow (below) and starts with **no history**.

## v8 — the native key hierarchy (as built)

One derivation tree covers every key v8 introduces or keeps. The load-bearing
split is **derived** (re-derivable from the seed; *cannot* rotate without
rotating the seed) vs **random-and-wrapped** (independently rotatable) —
anything that must rotate on revocation is random.

```
MK / master seed (random, per user — every full device holds it)
│
│  at-rest wrappings (ways to open the vault):
│    ← OS-keychain vault key (biometric-gated; per device)
│    ← Argon2id(password)                                  [portable fallback]
│    ← KDF(recovery code)                                  [cold start]
│
├─ DERIVED (deterministic, domain-separated KDF):
│    └─ per-relay identity keypair = KDF(MK, "relay-id" ‖ relay-fp)
│
└─ RANDOM, wrapped under MK (rotatable):
     ├─ profile key                 rotates on: unfriend ("block"), device revocation
     │   └─ delivery token = KDF(profile key, "delivery") → hash → relay verifier
     ├─ per-conversation epoch keys rotates on: membership change, device revocation
     ├─ per-note keys               rotates on: share revocation, device revocation
     └─ preview key (sealed to contacts; for push previews — not built)

Per-device (random, OS keychain, never leaves the device):
     ├─ device keypair — signs relay challenges → short-lived token;
     │                    pairing target for sealed MK
     └─ SQLCipher key — local DB at rest

Standalone:
     ├─ per-file attachment keys (random per file, carried inside the E2E message)
     └─ backup export key = KDF(recovery code / passphrase, "backup")  [not built]
```

Rust-side derivation lives in `keys.rs` (HKDF-SHA256 → AES-256-GCM wrap; info
strings `accord/mk-wrap/{vault-key,password,recovery}/v1`) and `identity.rs`
(`accord/relay-id/{ed25519,x25519}/v1`).

### Per-relay derived identities

Each relay gets a **distinct identity keypair derived from the one master seed**,
so independent relays **cannot collude to correlate** the same user across
servers — chosen over presenting one shared key everywhere. Handles are minted
per relay, so "same handle everywhere" was never guaranteed anyway.

To authenticate, the device **signs the relay's challenge**: the relay issues a
random nonce, and the device signs a payload containing both the nonce **and the
relay's own identity**, so a malicious relay cannot replay your signature to
authenticate as you to a different relay. The relay returns a short-lived bearer
token that the device silently re-signs — see [relay.md](relay.md#auth-d4d4b).

**Two independent layers, deliberately:** vault unlock (local, user-facing) and
the relay token (network, under the hood). Because the token refreshes on the
*device key* rather than MK, the relay connection stays alive to receive queued
traffic **while the vault is locked** — you re-unlock only to *read*.

### Delivery tokens (how reach is gated without identity)

The **profile key** is the access root: `delivery token = KDF(profile_key,
"delivery")`. The recipient registers a **verifier** (a hash of the token) with
the relay; a sender presents the **token**, and the relay checks
`hash(token) == verifier` → authorizes delivery **without learning who sent it**.
The sender's signed identity certificate rides *inside* the sealed envelope, so
the recipient learns the sender and the relay never does.

**Granularity: one shared token per recipient** (not per friend), so the relay
never learns your friend count. The cost is that unfriending **rotates the
profile key and re-issues to all remaining friends** (O(friends) sealed
messages — Signal's model), accepted because blocks are rare and friend counts
are modest. Groups use an analogous group delivery token.

"Block" is therefore **not a separate mechanism**: a 1:1 block is unfriend →
profile-key rotation → delivery-token revocation, and an in-group block is a
client-side hide.

### Account escrow & cold start

A password or recovery code alone would have **nothing to decrypt** on a fresh,
unpaired device against a stateless relay — MK is random and the identity keys
derive from it. So the relay stores the **password-wrapped and recovery-wrapped
MK** (a few hundred bytes — the same blobs as the shipped v1 model), registered
on **every relay the user joins** so a dead relay never strands the escrow.

This is a deliberate carve-out: zero-at-rest means zero **content** at rest. The
relay already persists the directory, KT log, delivery verifiers and push tokens;
key blobs encrypted under secrets only the user holds are not the honeypot the
posture exists to avoid.

**Why it's safe.** Argon2id runs **client-side and the password never leaves the
device** — the relay stores only a domain-separated auth-key hash, useless for
unwrapping (different HKDF domain). The historical caveat was *served code* (a
malicious server shipping JS that exfiltrates the password), and the signed
native app closes exactly that hole. Residual risk: a malicious relay can mount
an **offline brute-force against the password-wrapped blob** — bounded by
Argon2id (m≈19 MiB, t=2) plus the enforced 16-char minimum. The
recovery-code-wrapped blob (160-bit random) is computationally out of reach.

### Device revocation — two named tiers

So the UI and docs never oversell what revocation covers:

- **Tier 1 — "revoke lost device"** (the realistic case: lost or stolen but
  locked; keychain and SQLCipher intact). Stop honoring the device's token
  refresh — its relay access dies within the token window — **and rotate
  everything it could decrypt**: profile key (re-issuing delivery tokens to all
  friends), every conversation/group epoch key it was in, every shared-note key,
  and the preview key. Past content is compromised regardless, since the device
  held plaintext.
- **Tier 2 — "identity compromise"** (device compromised while *unlocked*). The
  attacker holds the master seed itself, so they can re-derive the per-relay
  identity keys — the one thing rotation cannot fix — and could even sign a
  fraudulent key-rotation attestation. Recovery = **new seed, new identity,
  re-verified with contacts out-of-band via SAS**. Tier 1 must never be presented
  as covering this case.

Neither tier is wired to a UI yet — see [roadmap.md](roadmap.md).

### What happened to passkeys

Native shells make WebAuthn **PRF** unreliable (broken on Linux), so v8
**re-scopes** passkeys rather than dropping them:

1. **Bootstrap/recovery authentication** to a relay where the shell supports
   WebAuthn — a synced passkey makes fresh-device sign-in phishing-resistant.
2. **Opportunistic PRF wrap** where PRF actually works — never load-bearing.
3. **Day-to-day relay auth stays the device key**; passkeys are not involved.

Registration therefore stops rejecting non-PRF passkeys (the auth role doesn't
need PRF). The **password is mandatory** in v8 because, absent reliable PRF, it
is the only universal MK-decryption factor; the recovery code stays break-glass.

## Server-side identity tables

- `users` — id, role, `public_key` (X25519), `wrapped_private_key`,
  `recovery_wrapped_mk`, `recovery_auth_hash`, the optional password-fallback
  trio (`password_salt`, `password_wrapped_mk`, `password_auth_hash`), the public
  `handle`, and (v3) `display_name`. There is **no username**: the auto-generated `handle`
  (`Word#1234`) is the sole identifier. (The legacy `username` column — a
  login-only, server-readable name — was dropped via a table rebuild; login is
  passkey/discoverable and recovery keys off the handle.)
- `credentials` — one row per passkey, each with its own `wrapped_mk` (this is
  how multi-device works: any registered passkey can unwrap MK).
- `sessions`, `invites` (admin signup invites), `challenges` (WebAuthn).
