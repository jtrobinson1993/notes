# v8 migration runbook (design)

> **Status: v8 design — executed once at the v8 cutover (D12: hard cutover;
> release strategy: one release).** Scope, per the decided line: **migrate
> everything we can** — notes, chat history, attachments, profiles, settings.

## Sequence

**T-0 — ship.** The v8 branch merges; the server deploys as the relay codebase
with the **legacy durable store still mounted read-only**; native apps go live
in stores. Standalone web is replaced by a landing page: *"install the app"* +
a migration-only sign-in (below). The web satellite (D12) activates once a
user has a native device.

**Per-user migration (first native run, automatic):**

1. **Bootstrap sign-in** with existing credentials — passkey or password
   (one-time, server-verified; this is the last thing the legacy auth stack
   does). Enrolls the new **device key**.
2. **Pull everything** into the local store ([local-store.md](local-store.md)):
   notes → seeded as Yjs docs + legacy server snapshots imported as read-only
   versions (D10); chat history + reactions/edits/read state → message rows +
   overlay docs; server-stored encrypted attachments → downloaded, re-keyed
   per-file, stored locally; profile blob; settings blob; friends list →
   contacts.
3. **Re-establish identity.** The v8 identity key is seed-derived (D4b), but
   contacts know the old random X25519 key — so the client publishes a
   **one-time attestation** (old key signs new key) into the KT genesis entry
   for the handle; migrated contacts' clients auto-trust the new key on
   verifying the old signature (same verify-once principle as D4c). *(Exact
   attestation format at build.)*
4. **Register v8 state** on the relay: KT binding, delivery-token verifiers
   (profile key → D6), escrow blobs (D15).
5. Account flips to **native-primary**; its legacy rows are marked migrated.

**T+60 days — purge.** All legacy durable content (messages, notes,
attachments, profile blobs) is deleted for migrated *and* unmigrated accounts.

## Stragglers

- Until T+60, an unmigrated user can still run the migration sign-in at any
  time.
- At T+60, unmigrated accounts get a **legacy encrypted export** (the shipped
  v2 backup format) generated and held for a further 30 days for authenticated
  download, then everything is purged. The export is importable into the
  native app later (identity via recovery code).

## The mixed period (honest expectations)

Between T-0 and a user's migration, that user **cannot use the app at all**
(standalone web is off — the hard cutover). Messages sent *to* them by
migrated friends queue in the relay mailbox (30-day TTL, D6). The user base is
small and known — coordinate the switch personally rather than engineering an
interop bridge; this is the accepted cost of the fastest route to
zero-at-rest (D12).

## Rollback posture

Until T+60 the legacy store is intact and read-only — if v8 hits a
catastrophic fault, the legacy web app can be re-enabled and migrated users'
*new* (post-migration) traffic is what's at risk, protected by their own
device replicas + exports (D8). After T+60 there is no rollback; that is the
point of the purge.
