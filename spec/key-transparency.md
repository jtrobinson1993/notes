# Key transparency (v8)

> **Status: as built — full AKD.** The relay runs a **Meta `akd` sidecar**
> (VRF-blinded labels, inclusion / append-only / key-history proofs) and the
> native client verifies end-to-end: inclusion, self-audit, and gossip-based
> split-view detection with a blocking alarm. An **interim Merkle path**
> (`ktMerkle.ts` — signed hash-chained roots + per-entry inclusion proofs over
> the handle-ordered directory) remains as the fallback when no sidecar is
> configured. **Not built:** SAS fingerprint verification (the server-trust-free
> anchor — see [roadmap.md](roadmap.md#sas-fingerprint-verification-d5)), the
> **heartbeat epoch** (see *Epochs* below), and a WASM `akd_core` verifier for the
> deferred web client ([roadmap.md](roadmap.md#d16--a-v8-web-client-deferred)).
> This is also the document D5 promises to *publish* so independent parties can
> audit relays.

## What is logged

One log **per relay**, over that relay's directory only (no cross-relay log —
federation is out). The logged binding is `handle → identity pubkey
(Ed25519/X25519)`. Device keys are **not** in the log — contacts encrypt to the
identity key; devices are an account-internal concern authenticated by the
identity (see [relay.md](relay.md)).

## The AKD sidecar (as built)

The directory engine is Meta's **`akd`** crate (`whatsapp_v1` configuration —
the engine behind WhatsApp KT), run as its own service in `akd-sidecar/` rather
than embedded in the Node relay. Rust stays Rust; no napi binding is needed.

**HTTP surface** (axum), bound to `127.0.0.1:$AKD_SIDECAR_PORT` by default and
guarded by a shared-secret **`AKD_SIDECAR_TOKEN` bearer** — it is an internal
API, never public:

| Endpoint | Purpose |
|---|---|
| `POST /publish` | `{entries:[{handle,key}]}` → `{epoch, root}` |
| `GET /lookup/:handle` | inclusion proof → `{proof, epoch, root}` |
| `GET /audit/:start/:end` | **append-only proof** between epochs |
| `GET /key-history/:handle` | every version a handle ever mapped to (self-audit) |
| `GET /vrf-public-key` | the VRF public key clients need to verify blinded labels |

Proofs cross as **serde JSON, not protobuf** — the `nostd` `akd_core` build a
future WASM verifier would use excludes the `proto` module, so JSON
deserializes uniformly on native and WASM.

**Persistence:** `KtDirectory::open(dir)` keeps a file-backed VRF key
(`vrf.key`, generated once) plus a whole-directory state snapshot
(`state.json`, written atomically after each publish and restored on open).
*Scaling note:* a whole-DB snapshot per publish is fine at relay scale; a
`Database` trait impl over SQLite is the upgrade path for large directories.

**Deployment:** a `akd-sidecar` docker-compose service on the compose network
with **no published port** and its own volume. The relay is wired via
`AKD_SIDECAR_URL=${AKD_SIDECAR_TOKEN:+http://akd-sidecar:8091}` — **set the
token in `.env` → full AKD; leave it empty → the interim Merkle path**.

**Relay integration is config-gated with graceful fallback** (`ktSidecar.ts`).
With a sidecar present, `PUT /api/relay/directory` publishes the
handle→identity-key binding and signs/chains the resulting akd root, and
`GET /api/relay/directory/:handle` returns
`{proof, epoch, rootHash, vrfPublicKey, kt:'akd'}`. With no URL set, the interim
Merkle path is unchanged. A handle change (`POST /api/relay/handle`) republishes
the same way, since the log is keyed by handle.

## Client verification (native, as built)

`akd_core` is a direct dependency of the Tauri core (default features off:
`whatsapp_v1, vrf, serde_serialization`); the heavy full `akd` crate is a
**dev-dependency only**, for generating proofs in tests, and stays out of the
app binary.

- **`verify_lookup`** → the verified identity key for a handle, and
  **`verify_key_history`** → every key the log ever bound to a handle
  (`src-tauri/src/kt.rs`).
- **`kt_self_audit`** derives your own handle + identity key, fetches
  `GET /api/relay/directory/:handle/history` (AKD backend only — the interim
  Merkle KT cannot prove history and answers 404), verifies it, and applies
  `self_audit_verdict(history_keys, my_keys)` — a key the log bound to *your*
  handle that you never minted is hard equivocation. On a clean, consistent
  result it advances the verified root; otherwise it raises a hard alarm.
- **Split-view detection is `(epoch, root)` equality**, not an append-only
  proof: `kt_observe_root` records every observed root, and a *different* root
  at an epoch already seen is provable equivocation on its own. Full append-only
  verification stays the **auditor's** job — `akd_core` deliberately doesn't
  ship it.
- **Gossip** rides a dedicated **`kt-gossip` envelope kind** (cleaner than
  mutating every message payload). `kt_gossip_send` seals your latest signed
  root to a friend, piggybacked best-effort on DM sends. On receipt the client
  verifies the relay's Ed25519 signature over `kt-root|{root}|{prev}` before a
  mismatch counts as equivocation — so a malicious friend cannot frame an honest
  relay — then observes the root and alarms on a split view.
- **Alarm surface:** `nativeKt.ts` subscribes to the `kt:alarm` Tauri event and
  runs one self-audit on connect; `KtAlarm.vue` renders a prominent,
  non-dismissable banner distinguishing split-view from foreign-key.

**Deferred:** a **WASM `akd_core` verifier** (plus a JS reimplementation of
self-audit/gossip) for the deferred browser client
([roadmap.md](roadmap.md#d16--a-v8-web-client-deferred)) — it needs
wasm-bindgen/wasm-pack tooling and is off the critical path while native is the
only client.

## Log structure

**AKD/CONIKS lineage** (the engine behind WhatsApp KT / Apple CKV), via Meta's
open-source `akd` crate running as the sidecar above — a separate service rather
than a napi binding into Node.

- **Epochs:** *as built*, the relay publishes a new epoch **synchronously on
  every directory change** — a registration, a directory PUT, or a handle change
  signs and chains a root before the request returns. There is **no batching and
  no heartbeat**: a relay with no key activity publishes nothing, so a quiet log
  is indistinguishable from a stalled one. This matters because the reference
  auditor's watch mode alarms when the newest epoch is older than its max gap
  (default 24 h) — on a quiet relay that alarm is a false positive today. The
  intended shape is coalescing (at most every few minutes) plus a **daily
  heartbeat epoch even with no changes**, so staleness is detectable; it is
  **unbuilt** ([roadmap.md](roadmap.md)).
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
`/api/relay/kt/roots`) →

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
   a **rewrite** (a prior epoch's rootHash changed) or a **stall** (nothing newer
   than `--max-gap-hours`, default 24). **Built** — but see *Epochs* above: with
   no heartbeat epoch on the relay, the stall alarm fires on any relay that
   simply had no key activity for a day.

**Independence is the point:** an auditor run by the relay operator proves
nothing. The root `README.md` documents the endpoints and the `npm run kt-audit`
invocation (§ *Key transparency*) and recommends third parties — researchers,
NGOs, power users, *other relay operators* — run it. Users already provide
distributed
split-view detection via envelope gossip; dedicated auditors add always-on,
whole-log coverage (an enhancement, not a dependency).

## Bootstrap honesty

Until an auditor/gossip ecosystem exists around a young relay, split-view
detection is weakest — which is exactly why **SAS fingerprint verification** was
specified alongside the log as the server-trust-free anchor. **It is not built
yet** ([roadmap.md](roadmap.md#sas-fingerprint-verification-d5)), so today the
log plus gossip is the whole of the MITM defence: a relay that equivocates
*consistently* to a pair of users who never gossip with anyone else would not be
caught. Users on a shared relay who exchange messages do co-observe the log, so
the gap narrows as soon as a third party is involved.
