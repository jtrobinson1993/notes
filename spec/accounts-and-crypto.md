# Accounts & cryptography

The identity and key-management foundation everything else builds on. All
encryption/decryption happens **client-side** (WebCrypto + `@noble/curves`);
the server only ever stores ciphertext, wrapped keys, and WebAuthn public keys.

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
  - *Password (optional fallback):* for users whose passkey can't produce PRF
    output (e.g. Firefox on Linux). A user-chosen password (**16-char minimum,
    enforced client-side only** — the server never sees it) + a random salt →
    **Argon2id** (`hash-wasm`, m≈19 MiB, t=2, p=1; memory-hard because the input
    is low-entropy, unlike the recovery code) → a third wrapped copy of MK, plus a
    separately-derived auth key whose hash the server stores. Set up under
    Settings → Security (requires an unlocked session); passkey stays the default
    and the password is offered as an "alternative method" on the login screen.
    `password.ts` holds the derivation; `INFO_PASSWORD_WRAP` namespaces the wrap.
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
- **Signup via invite:** passkey registration + a one-time recovery code. An
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

### Device linking (proposed — not yet built)

A smoother path: add a passkey to a new device *from an already-unlocked device*,
without spending the recovery code.

**Core invariant — MK only ever crosses the wire _sealed to a key held by the
receiving device_; the server (and any network observer) sees ciphertext only,
never plaintext MK.** MK living on the new device is not new — it is required
(every device needs MK) and the recovery flow already does it. This is the same
trust posture as the existing sealed-box sharing primitive, which it reuses:

1. The **new** device generates an ephemeral X25519 keypair and shows its
   *public* key (e.g. a QR code). The private key never leaves the device.
2. The **logged-in** device runs `sealKey(newDevicePublicKey, MK)` and posts the
   sealed blob to a short-lived, single-use relay endpoint.
3. The new device fetches the blob, `unsealKey`s MK with its ephemeral private
   key, registers its own passkey (its own `wrapped_mk`), and discards the
   ephemeral key.

A variant with the same invariant: the logged-in device wraps MK under a
high-entropy one-time **link code** (effectively an ephemeral recovery code)
that the new device enters to unwrap a short-TTL server blob — no new primitive.

**The real risk is authenticating the _target_ device, not the transport.** An
attacker who substitutes their own public key (or intercepts the link code) would
receive MK. Required mitigations:

- **Human-verified, out-of-band channel:** an in-person QR scan and/or a short
  comparison string (SAS) shown on both screens that the user confirms matches.
  The public key / link code must be bound to the user's real device by a human,
  never trusted from the network alone.
- **Single-use, short TTL** (seconds–minutes); the relay blob is deleted on
  pickup and the ephemeral key discarded.
- **Notify + audit:** linking raises a "new device linked" notice, and the new
  passkey appears in the credential list for revocation.

Done with channel authentication, linking has **no durable transferable secret**
(unlike the written-down recovery code, which is itself an off-device,
MK-equivalent secret), so it is equal-to-or-better than recovery codes — not a
step down. Skipping either invariant — a plaintext relay, or an unauthenticated
channel — **is** a compromise and is out of scope.

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
