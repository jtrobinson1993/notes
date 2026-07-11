# D12 — v8 launch plan (greenfield, no migration)

> **REVISED.** Original plan was a per-user data migration with an identity
> attestation. With ~4 users (me + 3 friends), that machinery isn't worth it.
> **v8 ships greenfield: no account migration.** Everyone creates a fresh v8
> account and re-adds friends. This document is now short.

## The plan

1. **⚠ Pre-launch — tell everyone to save their notes.** The cutover **wipes
   everything**: fresh accounts, no data carried over. Before flipping to v8,
   remind all users to **export/save any notes they want to keep**. Chat history
   is disposable; notes are not preserved. *(Now tracked in `spec/roadmap.md`
   D12.)*
2. **Deploy v8.** Stand up the v8 relay + the `akd-sidecar` (set `AKD_SIDECAR_TOKEN`
   for full-AKD KT, or leave empty for interim) — `docker compose up -d`.
3. **Ship the native app** (signed — see below), everyone installs it.
4. **Everyone signs up fresh** and re-adds each other via the built invite flow
   (SAS-verifiable). Done.

That's the whole cutover. No migration sign-in, no data pull, no identity
attestation, no T+60 purge, no rollback-to-legacy.

## What this eliminated (vs. the old migration plan)

- The **old-key-signs-new-key attestation** (the one open crypto decision) — gone;
  trust is established fresh via v8 invites + SAS.
- The **per-user data migration** — gone.
- **T-0 migration-only sign-in / T+60 purge / straggler exports / rollback** — gone.

## Remaining before launch (not migration-related)

1. **Code-signing + reproducible builds** for the native app — Apple notarization /
   Windows Authenticode / Linux signing (needs your dev certs/accounts) + a
   "verify this build" README section. This is D12's *trust/distribution* half and
   is independent of migration. **Decision: do it pre-launch, and provision the
   signing identities (yours).**
2. **Integrated shakedown** — run the whole stack together on a real deployment
   (relay + akd-sidecar + native app: messaging, voice, KT) before the merge.
3. **The merge** — merging the branch = shipping v8 (it's the cutover).

## Cleanup (code no longer needed)

The migration machinery is now dead code to **shelve or delete**:
- `web/src/lib/migrate.ts` (+ its tests) — the legacy data pull.
- `web/src/components/MigrationPrompt.vue` + its mount in `App.vue`.
- The Rust import IPCs used *only* by migration (verify none are reused by the
  local store's normal write paths before removing).
- `spec/migration.md` runbook → delete or mark superseded.

## What I need from you

- Confirm you want me to **do the cleanup** (shelve/delete the migration code +
  `spec/migration.md`), or leave it in place for now.
- Provision the **code-signing identities** when you're ready for #1 above.
