# Follow-ups

Captured ideas/bugs to pick up later (not yet implemented). Newest first.

_Nothing queued — the auth overhaul (drop the username so the `Word#1234` handle
is the sole identifier; optional Argon2id password fallback for users without a
working passkey) shipped on `feat/auth-overhaul`, and #4 (Josh re-prompted for a
passkey) was resolved by removing the app's inactivity auto-lock (relying on the
device lock; MK stays in `sessionStorage`, never persisted to disk)._
