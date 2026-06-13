# Accounts & cryptography

The identity and key-management foundation everything else builds on. All
encryption/decryption happens **client-side** (WebCrypto + `@noble/curves`);
the server only ever stores ciphertext, wrapped keys, and WebAuthn public keys.

## Cryptography model

Priorities: modern, boring, widely supported (Chrome, Firefox-based Zen, Safari).

- **Master key (MK):** random 256-bit, generated client-side at signup. Never
  leaves the client unwrapped. Held in memory for the session with a
  configurable auto-lock.
- **Key wrapping:**
  - *Passkey:* WebAuthn **PRF extension** output → HKDF-SHA-256 → wraps MK
    (AES-256-GCM). One wrapped copy per registered passkey. Passkeys without PRF
    support are rejected at registration with a clear message.
  - *Recovery code:* random 160-bit (base32 in groups of 4) → HKDF → a second
    wrapped copy of MK, plus a separately-derived auth key whose hash the server
    stores for recovery login. High entropy, so no slow KDF needed.
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
`INFO_RECOVERY_WRAP`, `INFO_SEAL`, plus `INFO_SETTINGS` for the encrypted
settings blob.

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
- **Signup via invite:** passkey registration + a one-time recovery code.
- **Login** with passkey; add/remove additional passkeys; **recover** with the
  recovery code (which re-registers a passkey).
- **Sessions:** server session cookie (`notes_session`, httpOnly, SameSite=Lax);
  the cookie is the sha256 of a random token. Mutating `/api/*` requests are
  CSRF-checked against the `Origin` header.

## Server-side identity tables

- `users` — id, username, role, `public_key` (X25519), `wrapped_private_key`,
  `recovery_wrapped_mk`, `recovery_auth_hash`, and (v3) `display_name`.
- `credentials` — one row per passkey, each with its own `wrapped_mk` (this is
  how multi-device works: any registered passkey can unwrap MK).
- `sessions`, `invites` (admin signup invites), `challenges` (WebAuthn).
