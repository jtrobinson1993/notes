# Follow-ups

Captured ideas/bugs to pick up later (not yet implemented). Newest first.

## Auth overhaul — drop the username, add a password fallback (decided 2026-06-22)

Two related changes to the accounts model, agreed with Jarrod. Both are
security-sensitive; see `spec/accounts-and-crypto.md` and update it as built.

### Drop the user-chosen username; the handle is the only identifier
- **Why:** the username is plaintext, server-readable (it can't be encrypted —
  the server needs it for signup-uniqueness and recovery lookup) and is exactly
  where people leak their real identity. Login is already **usernameless**
  (discoverable passkeys), so the username is nearly vestigial. Peers already
  never see it (the `Word#1234` handle invariant). Removing it anonymizes the
  user from the server/DB at the source instead of obfuscating.
- **What:** stop collecting a username at signup; use the auto-generated `handle`
  as the WebAuthn `user.name`/`user.displayName` and as the **recovery
  identifier** (recovery currently keys off username — `auth.ts` `recovery/login`
  + `getUserByUsername`). Migrate the `users.username` column / drop its use.
  Audit every `username` reference (`db.ts`, `routes/auth.ts`, `shared` types,
  `RegisterFlow.vue`, recovery UI).

### Password fallback for users without a working passkey (e.g. Takashi: Firefox on CachyOS, no biometric)
- **Why:** non-biometric users get bounced through awkward passkey fallbacks.
  A password lets them sign in directly. Passkey stays the **default**; the
  password flow is hidden behind an **"alternative methods"** link/button.
- **What:** add a password-derived key (Argon2id/scrypt → HKDF) that wraps a
  copy of MK, same shape as the existing recovery-code wrapping. Enforce a
  **long** password (high min length) + standard rate-limiting / lockout
  (mirror `recoveryAttempts` in `auth.ts`).
- **Hard warning, shown at password signup AND in Settings → Security:** there is
  **no "forgot password"** flow. Losing your password *and* passkey *and*
  recovery code means the account (and its E2EE data) is **unrecoverable**.
  Also recommend using a password manager + passkey instead of a password.
- **No 2FA/TOTP** (decided) — a passkey is already possession + biometric; the
  password path relies on length + rate-limiting instead.

## #4 — Josh re-prompted for passkey on every visit (mobile) — NEEDS DECISION
- **Diagnosis:** MK is held in `sessionStorage` (`session.ts` `setMk`). An
  installed iOS PWA gets a fresh browsing context per cold launch, which wipes
  `sessionStorage` → the app is "Locked" and demands a passkey every time he
  returns.
- **Fix is a security tradeoff** (persisting MK to `localStorage`/IndexedDB so it
  survives eviction = MK at rest on disk while the app is closed). Pending
  Jarrod's call; recommended mitigation is a **bounded at-rest lifetime**
  (persist MK with an expiry = last-activity + autolock window; discard on cold
  launch if expired) so the autolock guarantee survives eviction.
