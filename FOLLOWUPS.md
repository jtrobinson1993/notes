# Follow-ups

Captured ideas/bugs to pick up later (not yet implemented). Newest first.

## The relay should commit to its VRF public key

Contact verification ([spec/key-transparency.md](spec/key-transparency.md)) pins
the relay's **VRF public key** on first use, in the vault setting
`kt.vrfPub.<relayFp>`, and treats a later change as equivocation. Pinning is
needed because the VRF key decides which *leaf* a handle maps to: with a VRF key
of its choosing a relay can compute a proof mapping `Alice#0001` onto a leaf that
legitimately holds the attacker's key, and that proof verifies under a genuinely
signed root. Nothing in the relay's signed root chain covers the VRF key today,
so trust-on-first-use is the best the client can do — a relay hostile from a
client's *very first* lookup can still poison the pin.

The fix belongs on the relay: commit to the VRF key in the signed root payload
(e.g. `kt-root|{root}|{prev}|{vrfPub}`, versioned so existing roots still
verify), or publish a separately signed VRF-key record alongside
`/api/relay/kt/roots`. The client could then *verify* the VRF key instead of
pinning it, and a rotation would become a signed, auditable event rather than an
alarm. Touches `server/src/routes/relay.ts` (`appendSignedRoot`),
`kt::verify_signed_root`, `kt::contact_verdict`, the reference auditor
(`ktAudit.ts`), and the KT spec.

_Previously: the auth overhaul (drop the username so the `Word#1234` handle
is the sole identifier; optional Argon2id password fallback for users without a
working passkey) shipped on `feat/auth-overhaul`, and #4 (Josh re-prompted for a
passkey) was resolved by removing the app's inactivity auto-lock (relying on the
device lock; MK stays in `sessionStorage`, never persisted to disk)._
