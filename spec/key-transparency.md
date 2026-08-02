# Key transparency (v8)

> **Status: as built — full AKD.** The relay runs a **Meta `akd` sidecar**
> (VRF-blinded labels, inclusion / append-only / key-history proofs) and the
> native client verifies end-to-end: **contact keys on first trust** (the
> inclusion proof, against a root whose relay signature is checked first),
> self-audit, and gossip-based split-view detection. The hard alarm is a
> prominent banner; making it *block* sending is still open
> ([roadmap.md](roadmap.md#the-hard-kt-alarm-warns-but-does-not-block)). An
> **interim Merkle path**
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
  (`src-tauri/src/kt.rs`). Both are wired: `verify_lookup` through **contact
  verification** (below), `verify_key_history` through `kt_self_audit`.
- **`kt_self_audit`** derives your own handle + identity key, fetches
  `GET /api/relay/directory/:handle/history` (AKD backend only — the interim
  Merkle KT cannot prove history and answers 404), **resolves the returned root
  through the signed chain** (below), verifies the proof against it, and applies
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

## Contact verification — the directory-lookup path (as built)

This is the check the log exists for: **is the key I am about to trust for a
handle the one the log published for it?** Without it the log proves only that
the relay is consistent about *my own* key.

### The signed root is the anchor, and it is resolved first

An inclusion proof verifies against whatever root it is handed. Taking the root
from the same response that carried the proof therefore proves *nothing* — a
hostile relay just answers with a self-consistent `(proof, root)` pair for a key
it chose. So `kt::contact_verdict` resolves the root **before** it parses the
proof:

1. `kt::signed_root_epoch(keys, roots, root)` finds the response's `rootHash` in
   the relay's `GET /api/relay/kt/roots` chain and verifies the relay's Ed25519
   signature over `kt-root|{root}|{prev}` — the *same* check the gossip path
   already applies to a friend-supplied root, against the **delegated online
   key** established at connect (below). A root that is not in that signed chain
   is a fabrication.
2. Only then does `verify_lookup` run, against that root.
3. The verified value is compared with the key we were handed.

### The relay identity key is the anchor under the anchor

Resolving the root against the relay's signature only means something if the
**key** doing the verifying is genuinely the relay's. Every fact the client needs
comes from the relay itself (`GET /api/relay/info`), so they are established
before any of the above runs, and they are checked independently — see
[relay.md § Pinning the relay identity](relay.md#pinning-the-relay-identity-as-built):

- `identityFingerprint` must be `base64url(sha256(identityPubKey))`. A relay free
  to serve an honest fingerprint next to a foreign key would satisfy every pin,
  keep the account's derived identity and contact ids stable, and still sign a
  forged directory with the key root signatures are checked against — making
  every verdict here `Verified` while the relay chooses the keys. This check is
  unconditional on every connect and register.
- That fingerprint must equal the one this account is anchored to: an invite's
  `relayFp` where there is one, otherwise the pin stored on first contact. A
  change is refused with the same hard alarm tier as an equivocation
  (`relay-identity-changed`).
- **KT roots are not signed by the pinned key.** Since the relay identity split
  ([relay.md](relay.md#relay-identity-an-offline-root-and-an-online-signing-key)),
  `identityPubKey` is an **offline root** that signs one thing: a delegation
  naming the online key. So the chain a verifier walks is *pinned root →
  delegation → online key → root signature*. The delegation must verify under the
  pinned key, must not be expired, and must not carry a `version` lower than the
  highest already seen for this relay — otherwise an attacker holding a revoked
  online key replays its old, genuinely-signed delegation to be believed again.
  Each signed root names the `keyVersion` that signed it, so roots published
  before a rotation still verify (`ktAudit.ts::keysFromDelegations`, mirrored in
  the client by `delegation::DelegatedKeys::key_for`).
  This is what makes a relay breach survivable: the attacker gets the online key,
  and the operator revokes it with a delegation the attacker cannot forge.

  In the client this is enforced by types rather than by discipline:
  `signed_root_epoch`, `gossiped_root_is_signed` and `contact_verdict` all take a
  `delegation::DelegatedKeys`, which only `delegation::verify_chain` can build
  and only from delegations that verified under the pin. There is no overload
  that accepts a bare key, so "check this root against whatever the relay served"
  is not expressible. A root stamped with a version no delegation covers, or
  signed by the pinned root key itself, resolves to no key at all and counts as
  unsigned — `src-tauri/tests/kt_contact_verify.rs::kt_roots_signed_by_the_pinned_root_key_do_not_verify`
  is the regression test for exactly that.

  **Gossip is the one looser case, deliberately.** A `kt-gossip` beacon carries
  no `keyVersion`, so `gossiped_root_is_signed` accepts a signature under *any*
  key the pinned root delegated to — a friend may have seen a root published
  before the relay rotated, and requiring the current key would silently discard
  that split-view evidence. It costs nothing: gossip only ever adds evidence, and
  a signature matching no delegated key is ignored rather than believed (a friend
  must not be able to frame an honest relay).

The residual is the first connection to a relay reached with **no invite**
(`registerOnRelay`): that is trust-on-first-use, exactly like the VRF pin below,
and it converts a sustained attack into a one-shot at first contact rather than
eliminating it.

Two consequences worth stating plainly:

- **The epoch number is not the anchor; the root hash is.** `akd_core`'s
  `lookup_verify` does not bind its `epoch` argument tightly (a proof still
  verifies with the epoch off by one), and the akd epoch is the sidecar's own
  counter anyway — it does not line up with the relay's signed-root epochs,
  which are what gossip, `kt_roots_seen` and the auditor speak in. The client
  therefore records the **relay epoch of the signed root**, everywhere.
- **The VRF public key is pinned per relay (TOFU)**, in the vault setting
  `kt.vrfPub.<relayFp>`, and a change is a rejection rather than a rotation.
  The VRF key decides which *leaf* a handle maps to: a relay free to swap it
  could compute a VRF proof mapping `Alice#0001` onto a leaf that legitimately
  holds the attacker's key, and the inclusion proof would still verify under a
  genuinely signed root. The relay's root signature does **not** cover the VRF
  key today, so first-use pinning is the available defence; having the relay
  sign the VRF key into the root chain would remove the TOFU window and is
  listed in [roadmap.md](roadmap.md).

### Where it runs

Everywhere a contact key is first trusted — in the Rust core, since the device
token and all networking live there:

| Moment | Command | What is checked |
|---|---|---|
| Connecting / signing up | `relay_connect`, `relay_register` | the relay's own identity: fingerprint binds its key, and both match the invite's `relayFp` or the stored pin |
| Redeeming an invite | `relay_invite_redeem` | the invite's `relayFp` against the connected relay, then its TOFU pin (`handle` + `identityPub`) — both **before** the sealed friend-accept is sent |
| Invite signup's follow-up leg | `relay_register_friend_accept` | the same pin, before delivery |
| Inbound `friend-accept` / `friend-confirm` | `relay_mailbox_drain` | the *verified envelope sender's* key against the handle in the payload, **before** `record_friend` and before the reciprocal confirm is sealed |
| Relay connect | `kt_verify_contacts` | every contact still recorded without a proof |

**Ordering is the property, not an implementation detail.** A friend-accept is
answered with a friend-confirm carrying *my delivery token*; an invite redeem
sends an accept carrying it too. Verifying after replying would hand that token
to an impostor whatever the verdict then said, so the check gates the send.

### Verdicts

| Verdict | Meaning | Behaviour |
|---|---|---|
| **Verified** | the log published exactly this key for this handle under a signed root | proceed; the signed epoch is stored on the contact (`contact_relays.kt_verified_epoch`) |
| **Rejected** — key mismatch, invalid proof, unsigned root, or a changed VRF key | the relay actively contradicts its own signed log | **fail closed**: nothing recorded, nothing sealed back, hard `kt:alarm` (`contact-key-mismatch`), and `KT_CONTACT_KEY_MISMATCH` surfaced to the user on the interactive paths |
| **Unverified** — 404, no AKD backend, relay/directory unreachable, no relay key | no proof either way | proceed, recorded **unverified**, re-checked on the next connect |

A rejected envelope is still **acked**: it is permanently unusable, and
re-draining it would only replay the same rejection.

An unverified contact is never rendered as verified — `friends_list` carries
`kt_verified_epoch`, and the friends list shows "Key verified" only for a real
epoch, "Key not verified" otherwise.

### The 404 case — unverified, deliberately not blocking

A 404 means the relay claims the handle has no directory entry. It is treated
exactly like an unreachable directory: **never a match, never a block.**

- It is **indistinguishable from a benign race.** Publishing directory keys is
  best-effort at signup (`publishSelf` retries on the next connect), so an
  accept can genuinely arrive before the sender's entry lands. Blocking would
  break first-contact onboarding for a non-adversarial failure.
- It **denies an attacker nothing.** A relay that wants to withhold proof can
  answer 404, 503, or simply hang; if 404 blocked, the same relay would just
  stall instead. Blocking on 404 buys no security while costing real
  reachability — including offline use, where no lookup is possible at all.
- The exposure it leaves is bounded and visible: the contact is recorded
  **unverified**, is shown that way, and the sweep on every relay connect
  re-checks it. A relay sustaining the lie must keep 404-ing forever, and the
  moment it answers, a contradiction becomes a hard alarm.

What is *not* tolerated is the log answering and disagreeing. That is the one
case the relay cannot reach by silence, and it fails closed.

### Re-verification

`kt_verify_contacts` (run from `nativeKt.startKtAudit()` on connect, alongside
the self-audit) sweeps every friend with `kt_verified_epoch IS NULL` and settles
them. A proof only ever marks the row verified if it matches the `identity_pub`
still stored there, and a contact whose key changes is dropped back to
unverified by `record_friend`, so a proof for the old key can never vouch for a
new one. On a sweep rejection the verification is cleared and the hard alarm
fires — the contact is **not** silently deleted; making the alarm *block* is a
separate roadmap item.

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
- **Signed root** per epoch: `{epoch, rootHash, prevRootHash, timestamp,
  keyVersion}` signed by the relay's **delegated online key**, with `keyVersion`
  naming the delegation that key came from. The pinned anchor (an invite's
  `relayFp`, D4b) is the *root*, one link further out — see *The relay identity
  key is the anchor under the anchor* above.

## Proof types & client behavior

| Proof | When the client checks it |
|---|---|
| **Inclusion/lookup** | whenever a contact key is first trusted, and on the reconnect sweep — see *Contact verification* above. Always against a root resolved through the **signed** chain first |
| **Self-audit (history)** | on connect for the client's *own* handle — proves the log has only ever mapped it to keys this account actually minted |
| **Consistency/extension** | **not client-side.** `akd_core` ships no append-only verifier; the client's equivocation defence is `(epoch, root)`-equality over `kt_roots_seen`, and full consistency verification is the reference auditor's job |

- The client caches the latest verified root per relay (`kt_state`, see
  [local-store.md](local-store.md)).
- **Gossip:** DM sends piggyback the sender's latest signed root on a
  `kt-gossip` envelope; the recipient verifies the relay's signature over it and
  records it. A *different* root at an epoch already seen = **split view** — the
  relay is showing different logs to different users.
- **Alarms:** the *hard* tier — failed self-audit, gossip split-view, a contact
  key the log contradicts, or a relay whose own identity chain fails
  (`relay-identity-changed`, `relay-delegation-invalid`,
  `relay-delegation-rollback`) — raises `kt:alarm`, which `KtAlarm.vue`
  renders as a prominent, non-dismissable banner. Note what is **not** an alarm:
  a *changed online key under a valid, newer delegation* is a legitimate
  rotation and passes silently. It does **not** yet halt
  sending to affected contacts; that is an open roadmap item
  ([roadmap.md](roadmap.md#the-hard-kt-alarm-warns-but-does-not-block)). The
  *soft* tier (a contact's key changed with valid proofs → badge + inline
  notice, re-verify via SAS) is unbuilt and waits on SAS.

## Roots endpoint (public, unauthenticated)

`GET /.well-known/accord/kt-roots?since=<epoch>` (alias of
`/api/relay/kt/roots`) →

```json
{ "relayFp": "…",
  "delegations": [ { "version": 1, "onlineKey": "…", "issuedAt": 1785…,
                     "notAfter": 1817…, "signature": "…" } ],
  "roots": [ { "epoch": 41, "rootHash": "…", "prevRootHash": "…",
               "timestamp": 1789…, "signature": "…", "keyVersion": 1 } ] }
```

Anyone can fetch and verify the full chain for free — this is the auditor
surface. Two fields exist because of the
[relay identity split](relay.md#relay-identity-an-offline-root-and-an-online-signing-key):
**`delegations`** rides along (the full ascending chain, each signed by the
offline root) so one response plus the pinned root key is enough to verify
everything here without a second fetch, and each root's **`keyVersion`** names
the delegated online key that signed it, so a root published before a rotation
still verifies instead of failing under the current key. A root whose
`keyVersion` no delegation covers resolves to no key and counts as unsigned.
`relayFp` is the **root** fingerprint, unchanged by rotation.

**What a bare fetch does and doesn't prove.** These fields let a third party
verify the log is internally consistent and was not rewritten. They cannot, on
their own, prove it is *this relay's* log: an auditor that takes the root key
from the same server it is auditing is checking a document against its own
letterhead. The bundled CLI does exactly that today — it reads `identityPubKey`
and `delegations` from `/info` and pins nothing — so it detects a rewritten or
mis-signed history, not a wholesale substitution. Closing that gap needs the
auditor to be given the fingerprint out of band, which is the same anchoring
problem clients solve with an invite's `relayFp`
([relay.md](relay.md#pinning-the-relay-identity-as-built)).

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

Two bootstrap windows are worth naming precisely, because contact verification
inherits them rather than closing them:

- **The VRF pin is trust-on-first-use.** A relay hostile from a client's very
  first lookup could pin its own VRF key on that client and thereafter aim any
  handle at any leaf. Pinning converts a *sustained* attack into a one-shot at
  first contact, the same posture as the relay fingerprint on an invite-less
  signup; the durable fix is the relay committing to its VRF key in the signed
  root chain.
- **The relay fingerprint is anchored, but only as well as the channel it came
  through.** An invite carries it out-of-band, so an invited user is anchored
  from their very first connection. Someone who typed a relay address (or pasted
  an operator registration code, which carries no fingerprint) is TOFU — see
  [relay.md](relay.md#pinning-the-relay-identity-as-built) and the roadmap item
  for putting the fingerprint into operator codes too.
- **"Not in the log" is not proof of anything.** A relay can withhold an entry
  (404) or stall, and contact verification then records the contact unverified
  rather than blocking (see *The 404 case*). What it cannot do is publish a
  contradicting key without that being caught and alarmed.
