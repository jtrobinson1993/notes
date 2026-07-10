# D12 — legacy → v8 cutover: decisions & plan

> **Purpose.** This is the decision/planning layer for the v8 "hard cutover."
> The step-by-step runbook lives in [`spec/migration.md`](spec/migration.md);
> this document lists **what still needs deciding**, the current state of each
> piece, the options, and a recommendation — so you can approve a direction
> before I build.

## The shape of it

v8 is a **hard cutover, not a gradual rollout**. There is no mixed-mode period
where legacy and v8 clients interoperate — at merge/ship, the server becomes the
v8 relay (legacy durable store mounted **read-only**), native apps go live, and
each user does a one-time migration on first native run. Between T-0 and a user's
migration, **that user cannot use the app** (spec/migration.md § "the mixed
period"). So "merge the branch" ≈ "ship v8". That's why the cutover is its own
project and not just another feature.

## Current state (what's already built)

- **Per-user data migration** — `web/src/lib/migrate.ts` already pulls notes
  (→ Yjs docs + read-only legacy version snapshots), chat history + reactions/
  edits/read-state, attachments (re-keyed per file), profile, settings, and
  friends → contacts into the Rust core over idempotent import IPCs.
- **The v8 relay** — messaging, groups, attachments, voice, and key transparency
  (interim Merkle **and** full-AKD via the sidecar) are all built and green.
- **Identity model** — v8 identity keys are seed-derived per relay (D4b).

## Open decisions

### 1. Identity attestation (old-key-signs-new-key) — **needs your sign-off on format**

**Why it exists.** Contacts already know your *legacy* identity key. Your v8
identity key is newly seed-derived, so migrated contacts must be told "this new
key is really the same account" — without trusting the server. The migration
publishes a **one-time attestation**: the old key signs the new key, dropped into
the KT genesis entry for the handle. A contact's client auto-trusts the new key
after verifying the old signature (same verify-once principle as D4c invite
pinning). Spec calls the exact format "at build" — this is that decision.

**Open question — which old key signs?** Pre-v8, the key contacts held was the
account's **X25519** profile/identity key (used for *encryption*, not signing).
X25519 can't produce an Ed25519-style signature directly. So we must pin one of:
- **(a)** The legacy account also had/derives an **Ed25519** signing key contacts
  can verify against → the attestation is a plain Ed25519 signature. *Cleanest if
  such a key exists in the legacy model.*
- **(b)** Bind via the X25519 key using a VRF/DH-based proof (the old key proves
  possession without a classic signature). More work; avoids needing a legacy
  signing key.
- **(c)** Fall back to **SAS re-verification** for contacts (no cryptographic
  auto-trust; each contact re-verifies via safety numbers post-migration). Safest
  to reason about, worst UX.

**Proposed format (assuming (a)).** A signed statement
`v8-identity-migration|{handle}|{newIdentityPubKeyB64}|{relayFp}` signed by the
legacy signing key; published as the attestation field of the handle's KT genesis
entry; the relay serves it at directory lookup; the contact verifies the legacy
signature (against the legacy key it has pinned) and then trusts + pins the new
v8 identity key.

**Decision needed:** confirm (a) is possible against the real legacy key model
(I'll check the legacy account/crypto code), or pick (b)/(c). Then I implement +
test the chosen scheme (bounded, crypto-shaped, testable).

### 2. Code-signing + reproducible builds — **release engineering, mostly yours**

D12's trust story is a **signed, reproducible native app** anyone can rebuild and
verify. Needs:
- Apple notarization / Windows Authenticode / Linux signing for the Tauri
  bundles (needs your developer certs / accounts).
- A reproducible-build recipe (pinned toolchains, locked deps — the akd-sidecar
  already commits `Cargo.lock`) + a "verify this build" section in the README.

**Decision needed:** whether to tackle this pre-merge (recommended: it's the
whole point of "native improves trust", D12) and provisioning the signing
identities (yours).

### 3. T-0 landing page + migration-only sign-in — **buildable now**

At T-0 the standalone web app is replaced by an "install the app" landing page +
a **migration-only** sign-in (last thing the legacy auth stack does: verify
existing passkey/password once, enroll the new device key, then hand off to the
per-user migration). The web satellite (D12) reactivates once a user has a native
device.

**Decision needed:** none blocking — I can build this. Confirm the copy/flow and
I'll implement.

### 4. T+60 purge tooling — **buildable now**

At T+60 days all legacy durable content is purged; stragglers get a one-time
legacy encrypted export (importable into the app). Needs an admin/cron purge job
+ the export builder.

**Decision needed:** confirm the 60-day window + who triggers the purge (manual
admin action vs. scheduled), then I build it.

### 5. Cutover timing & coordination — **operational, yours**

The hard cutover means picking a T-0, telling users, and accepting the
per-user-migration window. Because it's a self-hosted app with (presumably) a
small user base, this can be a personal coordination ("everyone update by X").

**Decision needed:** your T-0 target and how you'll notify users.

### 6. Rollback posture — **decided in spec, confirm**

Until T+60 the legacy store is intact + read-only, so a v8-blocking bug can roll
back to legacy (read-only) while fixing. After T+60 there is no rollback (that's
the point of the purge). This is already the spec's posture — just confirming
you're comfortable with it.

## Recommended sequence

1. **Now (no deployment gate):** I build **#1 the attestation** (after I confirm
   the legacy key model) — the last crypto-shaped piece — and **#3 the T-0
   landing/migration-sign-in** + **#4 purge tooling** as they're
   straightforward.
2. **You, in parallel:** validate voice on real devices (per your note, once
   initial implementation is done), and decide the **#5 T-0 timing** + provision
   **#2 signing identities**.
3. **Pre-merge:** an integrated shakedown of the whole v8 stack on a real
   deployment (relay + akd-sidecar + native app), then the merge = ship.

## What I need from you to start

- **#1:** OK to inspect the legacy key model and propose the concrete attestation
  scheme for your approval? (Or pick (b)/(c) up front.)
- Anything you want to reorder above.
