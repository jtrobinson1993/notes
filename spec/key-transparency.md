# Key transparency (v8 design)

> **Status: v8 — partially built.** Built: signed hash-chained epoch roots +
> **per-entry Merkle inclusion proofs** on directory lookup (server
> `ktMerkle.ts`; the root is a binary Merkle tree over the handle-ordered
> directory, `GET /api/relay/directory/:handle` returns `{ rootHash, epoch,
> proof }`, verified by the shared `verifyInclusion`). Still design-only: VRF
> **label blinding** (leaves are still handle-derived, so the tree is not yet
> privacy-preserving), consistency/extension proofs between epochs, self-audit
> history, and the reference auditor. This is also the document D5 promises to
> *publish* so independent parties can audit relays.

## What is logged

One log **per relay**, over that relay's directory only (no cross-relay log —
federation is out). The logged binding is `handle → identity pubkey
(Ed25519/X25519)`. Device keys are **not** in the log — contacts encrypt to the
identity key; devices are an account-internal concern authenticated by the
identity (see [relay.md](relay.md)).

## Full-AKD feasibility spike (`akd` crate — de-risking the "confirm at build")

Ran a throwaway spike against Meta's **`akd` 0.12.0** (`github.com/facebook/akd`,
MIT/Apache) to de-risk the sidecar path before committing. Conclusion: **GO is
feasible; no dead-ends.** Findings:

- **Builds clean, production-proven.** Compiles on Rust 1.96 in seconds; pulls
  `ed25519-dalek` + `blake3` (already ours) + `protobuf`. The `whatsapp_v1`
  config feature is the engine behind WhatsApp KT — maintained by Meta.
  *Caveat:* the old standalone `akd_client`/`akd_mysql` crates lag at 0.8.9
  (novifinancial era) — superseded: verification now lives in `akd_core::verify`;
  MySQL is just one optional storage crate.
- **No mandatory MySQL** (my biggest flagged risk — resolved). `akd` exposes a
  `Database` trait with a built-in in-memory impl (`storage/memory.rs`); MySQL is
  a separate optional crate. We implement the trait over our SQLite/filesystem
  (or run in-memory + snapshot). No new stateful datastore forced on the relay.
- **All three proof types are first-class:** `publish(Vec<(AkdLabel, AkdValue)>)
  → EpochHash`; `lookup(label) → (LookupProof, EpochHash)` (inclusion);
  `audit(start,end) → AppendOnlyProof` (consistency/append-only); `key_history
  (label) → HistoryProof` (self-audit). `get_public_key() → VRFPublicKey` — **VRF
  label blinding is built in** (the privacy property our interim Merkle lacks).
- **Client verification is `no_std`/WASM-viable** (my other big flagged risk —
  resolved). `verify` (`lookup_verify`, `key_history_verify`) lives in the light
  `akd_core`, which compiles clean with `--no-default-features --features
  nostd,vrf,whatsapp_v1` → a **wasm-bindgen** shim gives the JS **web satellite** a
  verifier. The **native Tauri core can embed `akd_core::verify` directly** (plain
  Rust dep — no napi/WASM). *Wiring detail:* nostd excludes the `proto` module, so
  a WASM verifier marshals proof **structs** across the JS↔WASM boundary rather
  than protobuf bytes — extra glue, not a blocker.

**Recommended shape (when we do it):** `akd` in a **sidecar** (its own
docker-compose service, `docker compose up` unchanged) implementing the
`Database` trait over SQLite; Node relay calls it for publish/lookup/audit;
native client verifies via `akd_core` (direct dep), web satellite via a WASM
`akd_core`. **Still off the v8 critical path** — ship v8 on the interim KT
(chained roots + Merkle inclusion proofs + auditor), do full-AKD as a post-v8
hardening milestone. The spike's point: that milestone is now scoped and
unblocked.

## Log structure

**AKD/CONIKS lineage** (the engine behind WhatsApp KT / Apple CKV; lean on
Meta's open-source `akd` crate — it's Rust, so the Node relay embeds it via a
napi-rs binding; confirm at build).

- **Epochs:** the relay batches directory changes and publishes a new epoch
  **on change, at most every few minutes; at least daily** (heartbeat epoch
  even with no changes, so staleness is detectable).
- **Labels are VRF-blinded** — auditors and other users can verify the tree
  without learning which handles exist (privacy-preserving directory).
- **Signed root** per epoch: `{epoch, rootHash, prevRootHash, timestamp}`
  signed by the **relay identity key** (the same key pinned via invite
  fingerprints, D4b).

## Proof types & client behavior

| Proof | When the client checks it |
|---|---|
| **Inclusion/lookup** | on every directory fetch — the returned key is proven present in the current epoch |
| **Consistency/extension** | whenever a newer root is seen — epoch *n+1*'s tree provably extends epoch *n* (append-only) |
| **Self-audit (history)** | periodically for the client's *own* handle — proves the log has only ever mapped it to keys this account actually minted |

- The client caches the latest verified root per relay (`kt_state`, see
  [local-store.md](local-store.md)).
- **Gossip:** every E2E envelope to a contact on a shared relay piggybacks the
  sender's latest seen signed root; the recipient checks consistency between
  that root and its own. Two roots for the same epoch range that don't extend
  each other = **split view** — the relay is showing different logs to
  different users.
- **Alarms** (per D5/UI): *soft* — a contact's key changed with valid proofs
  (likely a legitimate new key; badge + inline notice, re-verify via SAS).
  *Hard* — failed self-audit, failed consistency, or gossip split-view: a
  blocking alert that halts sending to affected contacts and offers SAS
  re-verification / relay disconnect.

## Roots endpoint (public, unauthenticated)

`GET /.well-known/accord/kt-roots?since=<epoch>` (alias of
`/api/kt/roots`) →

```json
{ "relayFp": "…", "roots": [ { "epoch": 41, "rootHash": "…",
  "prevRootHash": "…", "timestamp": 1789… , "signature": "…" } ] }
```

Anyone can fetch and verify the full chain for free — this is the auditor
surface.

## Reference auditor

A small open-source CLI (ships in this repo — `server/src/ktAuditCli.ts`, run
`npm run kt-audit -w server -- <relay-url> [--watch]`; verification core in
`ktAudit.ts`), doing exactly two jobs:

1. **Chain verification:** fetch all roots since genesis (or a saved
   checkpoint), verify each signature and the hash-chain linkage + strictly
   increasing epochs — proving the *published* history was never silently
   rewritten. **Built.** (Cryptographic *consistency/extension* proofs — that
   epoch n+1's tree provably append-only-extends epoch n — await the AKD
   history-tree structure; the current per-epoch snapshot Merkle root does not
   admit them.)
2. **Watch mode:** poll the roots endpoint, keep seen roots, and alarm loudly on
   a **rewrite** (a prior epoch's rootHash changed) or a **stall** (no fresh
   heartbeat epoch within a max gap). **Built.**

**Independence is the point:** an auditor run by the relay operator proves
nothing. The root `README.md` gets a "Verifying this relay's key transparency"
section at build (D5) recommending third parties — researchers, NGOs, power
users, *other relay operators* — run it. Users already provide distributed
split-view detection via envelope gossip; dedicated auditors add always-on,
whole-log coverage (an enhancement, not a dependency).

## Bootstrap honesty

Until an auditor/gossip ecosystem exists around a young relay, split-view
detection is weakest — which is exactly why **SAS fingerprint verification
ships in v8 alongside the log** (D5) as the server-trust-free anchor.
