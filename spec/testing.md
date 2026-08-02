# Testing

How Accord is verified today, and the strategy for the parts that are not
verified yet. Everything described as *built* below was checked against the
tree; every layer that is **not built** says so plainly and belongs to
[roadmap.md](roadmap.md).

Accord is a native Tauri app: the Rust core owns keys and storage, the webview
is UI only and reaches the core over `invoke()` IPC, and a standalone relay is
the backend ([native-app.md](native-app.md), [local-store.md](local-store.md),
[relay.md](relay.md)). The test layers follow those seams.

## What runs today

| Suite | Command | Size |
| --- | --- | --- |
| Vitest — projects `crypto`, `server`, `web` | `npm test` (root) | 787 tests across 109 files |
| Rust core — unit (L1) | `cargo test` in `src-tauri/` | 119 tests |
| Rust core ↔ real relay (L2) | same `cargo test` (`tests/relay_integration.rs`) | 2 tests |
| Rust core ↔ a **hostile** relay (L2b) | same `cargo test` (`tests/kt_contact_verify.rs` 15, `tests/group_invite_authz.rs` 6) | 21 tests |
| AKD sidecar | `cargo test` in `akd-sidecar/` | 10 tests |
| Playwright — relay over HTTP | `npm run e2e` | `e2e/voice.spec.ts` + `e2e/onboarding.spec.ts` |
| Playwright — the UI over a faked IPC (L3) | `npm run e2e:ui` | 17 tests across 4 files in `e2e/ui/` |
| Editor harness (manual / scripted, not CI) | `web/dev/` | see below |
| CSP probe — Chromium + WebKit (not CI) | `node web/dev/csp-probe.mjs` | see below |

CI (`.github/workflows/ci.yml`) runs five jobs on every push: Vitest with
coverage (`npm run coverage`), Playwright against the built relay, Playwright
against the app UI over the fake core (`npm run e2e:ui`, L3), a
production-image boot probe (catches deps pruned by `--omit=dev`), and
`cargo test --locked` for the Rust core.

Two things about those jobs are load-bearing and easy to undo by accident:

- The Rust job installs **Node** and runs with `ACCORD_L2_REQUIRE=1`, because L2
  spawns a real (Node) relay and would otherwise *skip* on a runner without a
  toolchain — a skip that still reports green is worse than no test at all.
- The Rust job also installs the **Linux webview headers**
  (`libwebkit2gtk-4.1-dev` and friends, the same list as `native-build.yml`).
  `tauri`'s default features pull `wry`, whose Linux dependency graph is
  `webkit2gtk-sys` / `atk` / `soup3` — all pkg-config build scripts. Without
  those packages the job dies while *compiling*, before any test runs, which
  reads as "the core is broken" rather than "the runner is missing a header".
- L3 is its own job rather than a step inside the relay job: both Playwright
  configs write `playwright-report/`, so sharing a job would have the second run
  clobber the first one's report artifact.

`native-build.yml` builds installers on tag/dispatch only and runs no tests.

**There is no browser product left to test.** The v1 passkey SPA and its
all-in-one Fastify app server are deleted, and with them the `E2E_TEST_AUTH`
seam (`POST /api/test/session`, `server/src/routes/test.ts`) that used to mint a
session with no passkey ceremony. Nothing in the tree can now produce
credentials outside the real flow: `e2e/helpers/deviceToken.ts` creates each
test account through the production `POST /api/relay/register` → `auth/challenge`
→ signed-nonce → `auth/token` path, against a relay booted with
`RELAY_REGISTRATION_MODE=public` (`playwright.config.ts`). The token returned by
`/register` is deliberately discarded so the signed-nonce path is exercised too.
Removing the seam is a security improvement, not a regression: a test-only login
route is a production liability however hard it is gated, and the sessionless
device-token flow made it unnecessary.

## The four-layer strategy

The native product is verified in four layers. **L1, L2 and L3 are built and all
three run in CI. L4 is not built** — the section below records the evaluation
(July 2026) of every way there is to build it and why the answer today is "not
yet"; the work itself stays in [roadmap.md](roadmap.md).

### L1 — Rust core unit tests (`cargo test`) · **built**

119 tests inside `src-tauri/src/`, module by module. This is where the security
core is proven, and it is deliberately the largest and cheapest layer:

- **Keys** (`keys.rs`) — wrap/unwrap round-trip with domain separation, group
  delivery-token determinism against the verifier's convention, recovery-code
  format + normalization.
- **Identity** (`identity.rs`) — per-relay identity is deterministic, distinct
  across relays and distinct from another MK's (cross-relay unlinkability);
  DM conversation ids are order-independent; derived identities sign and verify.
- **Vault** (`vault.rs`) — create then all three unlock paths (keychain,
  password, recovery code), wrong secrets rejected, the `vault.meta.json` field
  set is exactly the three local wraps plus public KDF params (nothing
  server-shaped creeps back in after the escrow removal), a pre-removal sidecar
  carrying a stale `escrow` object still opens on all three paths, the delivery
  token is a pure function of MK (so every device derives the same one), and
  **MK is cleared on lock**.
- **Envelope** (`envelope.rs`) — seal/open verifies the sender; a wrong
  recipient cannot open; tampered ciphertext, wrong group key and unknown
  versions are rejected.
- **Protocol / message disposition** (`message.rs`, 20 tests) — encode/decode
  round-trip, decode rejects unknown versions and missing required fields, and
  the disposition matrix: a valid message ingests with a *verified* sender,
  version skew and unknown kinds buffer, unrecoverable items are discarded.
  Per-kind cases cover friend accept/confirm (terminal) and garbage, edit /
  delete / react carrying the verified actor, group add-member bumping the
  version (and refusing to sign a relay-supplied record that is for another
  group or does not name us an admin), group invites carrying the group key **and
  the verified inviter** (a payload that also *claims* one is ignored), call
  offers, and KT gossip.
- **Store** (`store.rs`, 17 tests) — SQLCipher create/migrate/reopen, wrong key
  rejected, migrations idempotent on reopen, message + note FTS (including the
  note body projection), idempotent import batches, message paging/edit/delete,
  attachment rows through eviction, unread + activity ordering, reactions,
  the **write-once group key** (a second insert changes nothing, and the schema
  trigger aborts a direct UPDATE), the write-once relay identity, friend
  addressing, and KT state incl. split-view detection.
- **Blobs and attachments** (`blobs.rs`, `attachment.rs`) — atomic idempotent
  overwrite, **path-traversal ids rejected**, per-file distinct keys, the cache
  serving ciphertext without the relay, and self-correction when a row's file
  has vanished.
- **Accounts** (`accounts.rs`) — first run creates a default account, each added
  account gets an isolated directory, the registry survives reload.
- **Transport** (`relay_client.rs`, `relay_live.rs`, `voice_live.rs`) — the
  challenge signature binds the relay fingerprint, token refresh margin, WS URL
  scheme mapping (non-HTTP bases rejected *before* connecting), capped monotonic
  backoff, and frame classification/forwarding. `verified_identity` is covered
  link by link: the fingerprint must bind the served root key, **the pin is
  checked before the delegation** (so a substituted relay is reported as an
  impostor, not as a malformed record), and a missing / forged / tampered /
  expired / rolled-back delegation refuses the relay.
- **KT** (`kt.rs`) — signed-root verification against the relay's scheme, lookup
  proofs accepted / bad roots rejected, key history, and self-audit flagging
  only a key this device never minted. Plus the **contact verdict** built from
  real akd directories: the published key verifies, a contradicted key is
  rejected, a *self-consistent proof under an attacker-chosen or
  differently-signed root* is rejected, a forged proof is rejected, a swapped
  VRF key is rejected while first use pins, and an interim-KT relay yields
  "unverified" rather than either verdict. Since the relay identity split, the
  root-resolving cases run through a `DelegatedKeys`: a root signed by the
  **pinned root key** is not a signed root, a root claiming a `keyVersion` it was
  not signed under is not a signed root, and an online-key rotation leaves the
  pre-rotation epochs verifiable under the version that signed them.
- **Relay delegation** (`delegation.rs`) — the signed-byte layout matches the
  server's `relayIdentity.ts` exactly; a malformed record is refused before any
  signature check; every field is covered by the signature; a chain is refused
  when a member is signed by the wrong root, when versions are not strictly
  increasing, when the advertised current delegation is not the newest member, or
  when it has expired; and the anti-rollback check refuses an older version and a
  *different* key at a version already accepted, while allowing a rotation
  forward.

### L2 — Rust integration: two cores against a real relay · **built**

`src-tauri/tests/relay_integration.rs` runs **two independent core instances in
one process against a real spawned relay** — separate data dirs, vaults, device
keys and `RelayClient`s — walking the whole path: register → mint invite →
redeem → friend handshake both ways → DM → drain → ack → read state, and a
reply back the other way. It is the only layer that sees *both halves of a real
conversation at once*: L1 is client-side only, and the relay's Vitest suite is
server-side only.

**It runs the shipped engine, not a re-implementation.** The relay is booted as
`node server/dist/relay-index.js` (built first with `npm run build -w shared &&
-w server`) on a free port with a throwaway `DATA_DIR` and
`RELAY_REGISTRATION_MODE=public`. Before that, the harness does exactly what an
operator does: `node server/dist/relay-cli.js init-identity --out
<DATA_DIR>/relay-identity.json` mints an identity bundle into the throwaway data
dir, and the relay ingests it at boot. A relay refuses to start without one
([relay.md](relay.md#setup-the-identity-is-generated-off-the-relay-and-shipped-as-a-bundle)),
and the harness goes through the real command and the real bundle path rather
than seeding a key behind the CLI's back — the root private key the command
prints is captured by the test process and discarded, so the data dir only ever
holds the root's public half. The test waits for `/api/health` and kills the
child on drop, so a panicking run still leaves nothing behind. Both accounts are
created through the production `POST /api/relay/register` — there is no
test-auth seam here either. The only substitutions are that temp data dir and an
in-memory `Keychain` (a test must never write to the developer's OS keychain).

What it asserts that nothing else can:

- **Byte-identical plaintext.** The message B decrypts equals what A sent, byte
  for byte (the canary text is non-ASCII on purpose), under the id A assigned.
- **The relay never held it.** The queued envelope is checked for the plaintext
  *and* for the sender's identity key (sealed sender), and then every byte the
  relay actually wrote to `DATA_DIR` — `notes.db`, its WAL, **and its own
  request log** (a leak into a log breaks the property just as thoroughly) — is
  scanned for the message text and for both E2EE display names. A **positive
  control** runs first: the same scan must find a handle the relay legitimately
  does store, so "no plaintext found" can never pass vacuously.
- **The friend handshake completes both ways.** A records B from the redeemed
  invite's `friend-accept`, reciprocates a `friend-confirm`, and B records A from
  it — with the display name each side only knows because it was E2EE, keyed by
  identity (the contact id), not by handle.
- **Ordering is the relay's stamp, not the author's clock.** Three messages are
  sent with `sentAt` running *backwards* while the relay stamps them forwards;
  the page must come back in relay order, and each row must carry the exact
  stamp the relay returned to the sender. A's own tee and B's ingested row agree
  on that stamp, so both logs sort identically.
- **Ack removes the envelope.** The mailbox is inspected while the envelope is
  still queued, then drained; a re-fetch is empty and a re-drain ingests nothing
  (idempotent by id) rather than duplicating.
- **Read state advances.** An inbound message is unread, my own never is, and
  marking read clears it — including in the one-pass sidebar activity query.
- **The identity split is real end to end.** Onboarding asserts that what the
  client pinned (`identity.identity_pub`, the offline root) is **not** the key
  that will verify KT root signatures (`kt_keys.current().online_key`), against
  the shipped relay rather than a fake. Nothing else in the suite proves the
  server's `relayIdentity.ts` and the client's `delegation.rs` agree on the
  signed-byte layout — a one-character drift in either domain separator would
  pass every unit test on both sides and fail here.

Two seams made this possible without contorting the test, and both are small:
the core's modules are `pub` (nothing else links this crate as a library), and
the two commands with real logic in them — the mailbox drain and the DM send —
now have their bodies in plain functions (`app_lib::mailbox_drain`,
`app_lib::send_dm`) that take `&Mutex<Vault>` + `&RelayClient` instead of
`tauri::State`, with the `#[tauri::command]` reduced to a wrapper. The drain's
`kt:alarm` emit became an injected sink, so the test can assert an honest relay
raises no alarm. Driving the real drain matters: routing an inbound message by
its *verified* sender, hold-until-ack, and the reciprocated confirm all live
there.

**Skipping.** No node, no npm, or a relay that won't build or boot → the test
prints `SKIP (L2, real relay): <reason>` to stderr (visible with
`cargo test -- --nocapture`) and passes, so an offline machine isn't blocked.
`ACCORD_L2_REQUIRE=1` turns every skip into a failure, and CI sets it.

#### L2b — the core against a *hostile* relay

The same layer, inverted. `relay_integration.rs` proves the core works with an
honest relay; **key transparency is a claim about a dishonest one**, and a real
`server/` process will never lie on demand. So `tests/common/mod.rs` spawns a
~200-line HTTP relay the test controls byte for byte, connects a real `Vault` +
`RelayClient` to it, and the cases drive the real `app_lib::mailbox_drain` /
`app_lib::verify_recorded_contacts`. The akd proofs are generated with the full
`akd` crate (already a dev-dependency), so the bytes being verified are the ones
a real sidecar produces. Two files share that harness:
`kt_contact_verify.rs` (identities and keys) and `group_invite_authz.rs`
(authority over group keys).

Ten of the fifteen cases are about the relay's **own** identity, because
verifying contact keys against the relay's signed log is circular unless that
anchor holds (`connect_to_relay`,
[relay.md](relay.md#pinning-the-relay-identity-as-built)). The fake relay owns
both halves of the split identity — it holds the **offline root** private key,
which a real relay never does, and that is precisely what lets it mint the
forged, tampered and rolled-back delegations only an attacker would produce.
`identityPubKey` is the root key; the key that signs KT roots is the one its
delegation names (see
[relay.md](relay.md#relay-identity-an-offline-root-and-an-online-signing-key)).

Four cases cover the pin:

- a fingerprint that is not the digest of the key served with it → refused;
- **the genuine fingerprint served with a foreign key** → refused. This is the
  attack a pin cannot catch: every pin still matches, the account's derived
  identity is unchanged, and the swapped root would then vouch for a key of the
  attacker's choosing;
- an identity that **changes** after first contact → refused, hard alarm, and
  *not* silently re-pinned (the live session still names the pinned relay);
- an **invite naming a different relay** → refused at first contact (before any
  trust-on-first-use pin can be taken) and again at redeem, while the matching
  invite connects and pins.

Six cover the delegation link — *pinned root → delegation → online key → root
signature*:

- the **valid chain** end to end: the client pins the root, the KT roots verify
  under a *different*, delegated key, and contacts verify;
- a delegation signed by **another root** (the forgery a breached server needs)
  → refused, `relay-delegation-invalid`, no session left behind;
- a **tampered** delegation (one field re-pointed at another online key), and a
  relay serving **no** delegation at all → refused the same way;
- a **rolled-back** version, and a *different* key presented at a version already
  accepted → refused, `relay-delegation-rollback`, with the honest relay still
  connecting afterwards (the refusals poison nothing);
- a **legitimate rotation** to version + 1 → accepted **silently**: no alarm, no
  re-pin, and the reconnect sweep re-verifies contacts under the new key;
- a KT root signed by the **pinned root key itself**, stamped with the current
  delegation version → **not** a signed root, so the contact is rejected. This is
  the case that carries the whole split: if a key the client already trusts could
  sign KT roots, splitting the identity would have bought nothing.

The other five are the contact-key path:

- a key the log published under a **signed** root → recorded, carrying the
  *signed* epoch;
- a key the log contradicts → nothing persisted **and nothing sealed back** (the
  reciprocal confirm carries our delivery token, so the ordering is the
  property), hard alarm raised, envelope still acked;
- a self-consistent `(proof, root)` pair under a root the relay never signed →
  refused — the case that makes "verify the root's signature first" load-bearing;
- a 404 → recorded **unverified**, handshake still completes, no alarm;
- an unreachable directory → unverified, then the reconnect sweep verifies it,
  and a later contradiction is caught by the same sweep.

Every case here connects through `app_lib::connect_to_relay` rather than
`RelayClient::connect`, so the pinning the app performs is on the path of all
nine, not just the four that assert about it.

The adversarial *decisions* (forged proof, swapped VRF key, wrong relay signing
key) are unit-tested in `kt.rs` against real akd directories; this file exists
for the wiring — ordering, persistence, and what leaves the device.

##### Who may hand me a group key (`tests/group_invite_authz.rs`)

Six cases on the same harness, because a `group-invite` is an ordinary mailbox
envelope and *anyone* who can enqueue one — the relay included — used to be
obeyed by it ([chat.md](chat.md#who-may-hand-me-a-group-key)). Each starts from a
core with a log-verified friend already recorded, so "refused" is never just
"this account has no friends":

- an invite from a **non-friend** → refused; no key, no group row, no
  conversation, and no alarm (a stranger's invite is not evidence about any
  published key, and alarming would let anyone with mailbox reach spam a
  non-dismissable banner);
- an invite from a **verified friend for a new group** → joined, key stored,
  conversation created;
- an invite for a group the core is **already in** → the stored key is unchanged
  and a `group-rekey-refused` alarm fires, both from a stranger *and* from the
  verified friend who runs the group. Membership is not authority to rotate;
- an **identical** re-invite (add-member is idempotent and re-sends the same key)
  → silent no-op: no join, no refusal, no alarm;
- **two conflicting invites for one new group in a single batch** → the first
  wins on INSERT, the second is refused and alarms (the "already a member?" check
  runs before anything is written, so both reach the write, and only INSERT-only
  semantics separate them);
- an invite from a friend the log now **contradicts** → refused, nothing stored,
  `contact-key-mismatch`.

Still out of L2's reach, deliberately: group fan-out, attachments, and
the invite *string* assembly (`web/src/lib/invites.ts` is TypeScript — L2
reproduces the sealed `friend-accept` from the same core primitives, but the QR
payload's encoding is covered by the `web` Vitest project). The paging-cursor
defect ([roadmap.md](roadmap.md)) is where a regression test belongs the moment
it is fixed.

### L3 — Playwright against a faked Tauri IPC · **built**

`npm run e2e:ui` (`playwright.ui.config.ts`, specs in `e2e/ui/`) runs the **real
v8 UI in a plain Chromium** against a **stateful fake core** injected with
`page.addInitScript`, before any app module evaluates. There are **no production
code changes**: the app keeps calling `invoke()`, nothing in `web/src` knows the
suite exists, and there is no dev flag or build mode that turns the fake on. The
fake lives only in `e2e/ui/fakeCore.ts`.

**The seam** (checked against the installed `@tauri-apps/api` 2.11.1):

- `isTauri()` reads `globalThis.isTauri` — a fake that only sets
  `__TAURI_INTERNALS__` leaves `isNative === false` and the UI takes no native
  path at all.
- `invoke()` calls `window.__TAURI_INTERNALS__.invoke(cmd, args, options)`, and
  rejects with the command's error *value* — a bare string for the core's
  `Result<_, String>`, which is what the UI renders. The fake rejects the same
  way, with the core's own strings ("vault is locked", "wrong password", "not
  connected to a relay").
- Push events go through `invoke('plugin:event|listen', …)` with a handler
  registered via `transformCallback`, so the fake implements `transformCallback`
  and can *push* `relay:mail` / `kt:alarm` / `voice:frame` at the UI. It also has
  to implement `window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener`,
  which `unlisten()` calls **before** the `plugin:event|unlisten` command — a
  fake without it throws on every teardown path (lock, sign-out, unmount).

**The fake is a small core, not canned replies.** One state object holds the
vault status, device settings, the relay session, friends, groups,
conversations, the message log, reactions and notes; every command reads and
writes it, so commands compose the way the real ones do. Creating a vault makes
`vault_status` report unlocked; sending a message puts it in `messages_page`,
in `conversation_activity`, and at the top of the activity-ordered rail;
`dm_mark_read` clears the badge `dm_unread` produced. Crucially it enforces the
same *guards* as the core: everything that goes through `vault.store()` fails
while locked, and everything that needs a relay session fails without one. That
is what makes the re-lock test real — after `vault_lock` the UI cannot read
anything back even if it tries. State is mirrored into `sessionStorage`, so
`page.reload()` models a webview reload with the core process alive (MK still in
memory) while a fresh context models a cold launch.

Commands implemented: the full vault/settings/accounts set, the relay session
(connect, register, directory publish, verifier, invites, status),
mailbox fetch/ack/**drain**, friends, DM identity + unread + activity, DM and
group send/edit/delete/react, `messages_page` (including the core's
`(relay_ts, id)` row-value cursor and its `DESC` ordering), notes CRUD + search,
attachments/blobs, KT self-audit, the voice control plane, and the emoji
commands. Anything else rejects with `fake core: unimplemented command <cmd>`
and is recorded; every spec asserts that list is empty in `afterEach`, so the
day the UI calls something new the harness says so instead of silently drifting.

**Covered** — flows that had no automated coverage at all, because the Vitest
`web` project mocks `lib/native.ts` per test and nothing composes there:

- `vault-gate.spec.ts` — first run (handle choice, the 16-char minimum, the
  confirm mismatch, the one-time recovery code, display name, onboarding on a
  relay) then a reload that opens straight through; the locked wall, where a
  **wrong password does not open the gate** and the core's own error is shown;
  recovery-code unlock incl. case/separator normalization; and the silent
  keychain unlock.
- `app-shell.spec.ts` — the rail lists every conversation in activity order with
  unread counts; opening one shows its messages and clears its badge; sending
  moves that chat to the top and survives a reload; a pushed `relay:mail` lands
  in both the rail and the open conversation; and **re-lock teardown** — after
  "Sign out" the rail, friend names and message bodies are gone from the DOM,
  and unlocking rebuilds them from the core.
- `notes.spec.ts` — create, title, type into the real CodeMirror editor, and the
  content survives a route change *and* a lock/unlock cycle (which drops every
  decrypted note and re-reads it through `notes_load_all`).
- `friends.spec.ts` — the friends list shows the E2EE display name over the
  public handle, a friendship recorded by a drain reaches both the list and the
  rail, and an invite is the self-describing `accord://friend?i=…` capability.

Building it found two UI defects, both now in [roadmap.md](roadmap.md): the side
rail is **empty after a cold launch** (the gate opens before the relay redial, so
the conversation refresh loses a race it never retries), and the v8 chat renders
**newest-first**. Each has a test in `app-shell.spec.ts` asserting the *correct*
behaviour and marked `test.fail`, so the suite stays green today and reports
"passed unexpectedly" — a nudge to un-mark it — the day the bug is fixed. That is
the pattern for a known defect at this layer: never a skipped or inverted
assertion.

**Where the fake can drift from the real core** — the standing cost of this
layer, and the reason L3 is not a substitute for L1/L2:

- **It is a re-implementation.** Every command's behaviour is written twice; the
  fake can agree with the UI's expectations while the Rust core does something
  else. Only L1/L2 constrain the core. Treat an L3 failure as "the UI is broken",
  never an L3 pass as "the core is right".
- **No crypto, no relay, no SQL.** Envelopes are not sealed, senders are not
  verified, the DM conversation id is an FNV hash of the two identity strings
  rather than the core's derivation, and ids/ordering come from JS arrays rather
  than SQLCipher. Anything about *correctness of the protocol* is out of scope
  here by construction.
- **The mailbox queues decoded results, not envelopes.** `deliverInbound` /
  `deliverFriend` inject what a verified drain *would* have produced, so the
  disposition matrix (version skew buffering, discard, sender verification) is
  L1's job, not this layer's.
- **Timing is unreal.** Every command resolves in a microtask, with no network.
  A race that only shows up behind a real round trip can hide here — and one
  that shows up *because* everything is instant may not be a real bug. (The
  cold-launch rail race in [roadmap.md](roadmap.md) was checked both ways: it
  reproduces regardless of latency, because it is an ordering bug, not a timing
  one.)
- **Signature drift is silent in one direction.** If a Rust command gains a
  field, the fake keeps returning the old shape and the suite stays green. The
  unimplemented-command guard catches *new* commands, not changed ones; the
  typed wrappers in `web/src/lib/native.ts` and the Vitest `web` suite are what
  pin shapes.
- **One browser, one viewport.** Chromium only (the shipped shells are WebKit on
  macOS/Linux and WebView2 on Windows — see the CSP probe and the WebKit editor
  harness for the engine-parity checks), and desktop width only, so the mobile
  pane logic in `mobileNav.ts` is untested here.

**It runs in CI** (the `ui-e2e` job). It needs no relay and no Rust — only
`npm ci`, Chromium, and the Vite dev server the config boots itself on port 5173
(the port named in the shell's `devCsp`, so the page runs under the same policy
`npm run dev:native` does), and it finishes in ~8 s on five workers.
`strictPort` + `reuseExistingServer: false` mean a stale Vite from another
worktree fails the run loudly rather than serving a different tree
(`lsof -ti tcp:5173`).

Rejected alternatives: **`@tauri-apps/api/mocks` (`mockIPC`)** is the official
mock, but it mutates `window.__TAURI_INTERNALS__` in the *current* JS context —
under Playwright that is Node, the wrong side of the process boundary.
`addInitScript` is the page-context equivalent, and the fake copies `mockIPC`'s
shape. **`@srsholmes/tauri-playwright`** (pre-1.0, single author) was not taken
as a dependency for this: the seam is ~40 lines of `window` plumbing, and
writing it by hand keeps the harness debuggable and version-pinned to nothing.

### L4 — real-shell smoke against the packaged app · **not built (evaluated July 2026; deferred, see below)**

What it would be: one thin pass through the **actual built binary** — the real
WKWebView / WebKitGTK / WebView2 over the real Rust core — asserting the app
launches, the webview loads the bundled assets under the **production** CSP as
served by Tauri's custom protocol, the vault gate renders, and unlock works.
That is the only layer that sees packaging, the custom protocol, the IPC
capability set in `src-tauri/capabilities/`, and real OS keychain access. Every
other UI question belongs to L3, so L4 stays a *smoke* run — slow, bound to one
platform, and the easiest layer to make flaky.

#### The macOS blocker is gone; a security decision replaced it

The old note in this file said the macOS build simply could not be driven. That
is no longer true, and the reason matters more than the fact.

| Option | State (checked July 2026) | Platforms | App modification |
| --- | --- | --- | --- |
| `tauri-driver` (official, tauri-apps) | crate 2.0.6, May 2026, 246k downloads | Linux (WebKitWebDriver) + Windows (msedgedriver). **No macOS** — Apple ships no WKWebView driver | **none** |
| `@wdio/tauri-service` + `tauri-plugin-wdio-webdriver` | npm 1.2.0 / crate 1.2.0, 2026-06-25, MIT, `github.com/webdriverio/desktop-mobile` (official WebdriverIO org), ~52k npm downloads/month; 1.0.0 only shipped 2026-05-03 | Windows, Linux **and macOS** | **embeds a WebDriver HTTP server in the binary** |
| `@srsholmes/tauri-playwright` | npm 0.4.1, 2026-06-20, MIT, single author, 39 stars | all, via a socket bridge | **embeds a socket bridge plugin**, and requires `withGlobalTauri: true` |

The Tauri docs now recommend `@wdio/tauri-service` and describe the embedded
server as "how macOS is supported". `@wdio/tauri-service` is not a hobby
project — it is the WebdriverIO org's own package, MIT, at a stable 1.x, and it
is the option to take *if* we take one.

**But every macOS-capable option works the same way: it links an automation
server into the app.** `tauri-plugin-wdio-webdriver` starts an `axum` server on
`127.0.0.1:4445` (`TAURI_WEBDRIVER_PORT` overrides) implementing 47 W3C
WebDriver endpoints, **with no authentication of any kind** — no token, no
`Origin`/`Host` check. Anything that can open a loopback socket can create a
session, evaluate arbitrary JavaScript in the webview, and therefore call every
`invoke()` command with the vault unlocked: read every decrypted note and
message, send messages as the user, drive the relay. For an app whose whole
point is that plaintext never leaves the device — and which *locks the vault*
precisely because a local attacker is in the threat model — that is a backdoor,
not a test fixture. `@srsholmes/tauri-playwright` is the same shape plus
`withGlobalTauri: true`, which additionally hands the full Tauri API to any
script that gets into the webview, widening every XSS into a core compromise.

**Upstream's own gating advice does not work.** The plugin README says to add it
as `[target.'cfg(debug_assertions)'.dependencies]`. Cargo does not support that:
the [Cargo reference](https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html)
states `cfg(debug_assertions)`, `cfg(test)`, `cfg(proc_macro)` and
`cfg(feature = "…")` in a target table "will not work as expected and will
always have the default value returned by `rustc --print=cfg`" — and
`rustc --print cfg` **emits `debug_assertions`** (verified locally). So that line
evaluates to *always true* and links the WebDriver server into release builds
too. The only thing keeping it dormant would be the `#[cfg(debug_assertions)]`
on the `.plugin(…)` call in `lib.rs` — one source-level guard, defeated by a
profile that turns debug assertions on in release. A safe adoption has to use a
real cargo **feature** (off by default) instead.

#### Decision: not built, and not to be adopted without an explicit call

Three things point the same way:

1. **It is a genuine security tradeoff, not just more work**, so per
   [CLAUDE.md](../CLAUDE.md) it is escalated rather than decided in passing.
   Taking the embedded-server route means an unauthenticated automation server
   exists in the source tree of an E2EE app, one mis-gated `cfg` away from
   shipping.
2. **It would not test the shipped binary anyway.** The build under test carries
   an extra feature, an extra plugin and its dependency tree (`axum`, `objc2-*`),
   so its artifact is not the artifact users install — which is most of what L4
   was supposed to prove.
3. **The gap it closes is narrower than it looks.** The CSP's silent-failure
   risk is already covered off-shell by `web/dev/csp-probe.mjs` against the real
   `web/dist` and the real production policy, in **both** Chromium and WebKit;
   `native-build.yml` already proves all three platforms bundle. What is left
   uniquely to L4 is: the custom protocol actually serving that policy as a
   header, the capability set in `src-tauri/capabilities/`, keychain access on a
   real OS, and "the packaged app opens a window that isn't blank".

#### If and when we build it, this is the shape

Use **`tauri-driver` (official) on Linux, in CI, with no app modification** —
the only option that drives the *real release binary*, and therefore the only
one whose pass means anything about what users install. It has no macOS support,
and that is acceptable: L4 is a packaging check, not a development loop, and L3
already covers the UI on the dev machine.

Attach it to **`native-build.yml`'s Linux job**, which already builds the bundle
on tag/dispatch — the expensive part is paid for, so the smoke run costs an
`apt install webkit2gtk-driver xvfb` and one script. Do **not** add a Tauri build
to `ci.yml`: a 10–20 minute compile on every push, for a smoke test, is the wrong
trade. Drive it with plain JSON-over-HTTP (the W3C protocol is a handful of
`fetch` calls) rather than pulling in the WebdriverIO stack, matching the
reasoning that kept the L3 seam hand-written.

The reason this was not done as part of the evaluation: it cannot be run or
debugged from the macOS development machine at all, and a CI-only job that has
never executed is exactly the "green but meaningless" failure mode the rest of
this strategy avoids. It should be written by someone who can iterate against a
Linux runner. Tracked in [roadmap.md](roadmap.md).

## The Vitest suites

Three projects, defined in `vitest.config.ts`; `@notes/shared` is aliased to its
TypeScript source so no build step is needed.

- **`crypto`** (`node`, `web/test/crypto/**`) — the WebCrypto/`@noble` helpers
  that remain in the webview: `crypto.ts` wrap/unwrap and seal/unseal round-trips
  with tamper and wrong-key rejection, HKDF domain separation, note crypto,
  password handling, and `voiceCrypto` (the frame key schedule).
- **`server`** (`node`, `server/test/**`, 32 files) — the relay, built in-process
  with `buildRelayApp` + a temp-dir SQLite DB (`test/helpers/server.ts`) and
  driven through `app.inject()`. Covers: registration modes and invite gating,
  the sealed-send auth matrix, mailbox, directory, handles, groups (state
  signature + version anti-rollback), group send/blobs, blobs, push
  wake, KT (Merkle, sidecar, publish/lookup, and the `ktAudit` detector for a
  rewritten or stalled root chain), the SFU/voice signaling routes, DB accessors
  and migrations, rate limiting, security headers, and the live WS hub
  (`relayLive`). The **content proxies** (`relayContent.ts` over `gifSearch`
  (KLIPY), `emotes` (7TV) and `linkPreview`) have their own suite asserting the
  privacy property they exist for — the relay makes the outbound call, never the
  client — plus `ssrf.test.ts` for the address classifier, including the IPv6
  transition formats that smuggle an IPv4 address inside a v6 one.
- **`web`** (`jsdom`, `web/test/**` minus crypto, `web/test/setup.ts`) — the UI.
  The native IPC is mocked **at `web/src/lib/native.ts` with `vi.mock`**, not at
  `window.__TAURI_INTERNALS__`: the UI's contract is the typed wrapper, so
  mocking there keeps tests readable and fails loudly if a command's signature
  changes. Covers the `native*` command wrappers (chat, DM, friends, groups,
  invites, KT, notes, relay, SFU, vault, voice), the Pinia stores, the editor
  (8 files), components incl. `MarkdownView` rendering raw HTML inert, the toast
  queue, and voice. `web/test/lib/callHost.e2ee.test.ts` locks the fail-closed
  rule from [voice.md](voice.md): without WebRTC Encoded Transform the app
  refuses to place a call and refuses to answer (declining, so the caller isn't
  left ringing), while **hang-up is never blocked**. The emoji suites
  (`lib/emoji*.test.ts`, `components/EmojiText`, `components/EmojiPicker`) lock
  the client-side halves of the emote threat model from
  [chat.md](chat.md#emoji-emotes-the-picker-and-the-cap): content rendering
  caches while the picker does not, the per-message fetch cap holds **across a
  re-render and a remount** (a cap that only survived one paint would be no cap
  at all), a failed fetch still spends its charge, over-cap emotes degrade to
  literal text, search falls back to the offline cached set, and
  `registerEmote` refuses any origin but the pinned relay's.

`jsdom` limits what this layer can claim: it has no layout (see the editor
harness below) and no canvas, so `imageOptimize` is not unit-tested there.

## The relay Playwright suite

`npm run e2e` mints a relay identity bundle into the throwaway `DATA_DIR`
(`node server/dist/relay-cli.js init-identity --if-missing --out
<DATA_DIR>/relay-identity.json`, since the relay refuses to boot without one and
ingests the bundle itself — `--if-missing` so a reused `E2E_DATA_DIR` isn't
re-rooted mid-suite) and then boots the **built relay**
(`node server/dist/relay-index.js`) on a throwaway `DATA_DIR`, driving it over
real HTTP. Both specs are API-level — there is no SPA to navigate:

- `onboarding.spec.ts` — `/api/health`, and the pinned-identity handshake:
  `/api/relay/info` must report a fingerprint that is genuinely the SHA-256 of
  the advertised identity key (not an unrelated or empty string), stable across
  calls so the client's pin cannot drift mid-session, plus a live, unexpired
  delegation whose `onlineKey` is a *different* 32-byte key from the pinned one —
  otherwise the root/online split has bought nothing.
- `voice.spec.ts` — two independent peers get device tokens through the real
  flow and join the same SFU room against a **real mediasoup worker**: opus is
  in the router capabilities, the second peer sees the first as an
  identity-free ephemeral participant, and a join without a device token is
  **401**. The in-browser media round-trip is deliberately not covered here —
  see [voice.md](voice.md) and [roadmap.md](roadmap.md).

The suite runs serially (`workers: 1`) because the specs share one relay and DB.
WebKit is installed by `npm run e2e:install` but its project is commented out in
`playwright.config.ts`; only Chromium runs, which is harmless while every spec
is HTTP-only.

There are **two Playwright configs, deliberately**: this one boots the relay and
never opens the app, and `playwright.ui.config.ts` boots the app and never
touches a relay (L3 above). They share nothing but the binary — `testIgnore:
'**/ui/**'` here keeps the UI specs out of the relay run, so both stay
independently runnable.

## The WebKit editor harness

The editor conceals Markdown markers as **atomic** ranges, so visual caret
motion depends on layout geometry that **jsdom does not model** — a Vitest case
can pass while a real browser misbehaves. `web/dev/` mounts the real
`<MarkdownEditor>` with no auth, router or stores so caret behaviour can be
observed for real; `web/dev/README.md` documents day-to-day use, and
`web/dev/editor-probe.mjs` drives it headlessly in Chromium. It is dev-server
only and outside the typed build.

`web/dev/webkit-render-check.mjs` additionally drives that harness in **Linux
Chromium vs Linux WebKit** (the engine family Tauri renders with on Linux),
doing a caret-offset parity check, a per-construct probe, and screenshots. This
is the check that cleared Tauri for the editor, and it is worth re-running after
editor changes:

1. Serve the harness bound so a container can reach it. Vite **403s** the
   `host.docker.internal` Host header, so use the host **LAN IP**:
   ```sh
   npm run dev -w web -- --host 0.0.0.0 --port 5173
   ```
2. If Docker is Colima-backed, start the VM: `colima start --cpu 4 --memory 4`.
3. Run it in the Playwright image (LAN IP from Vite's "Network:" line):
   ```sh
   docker run --rm --ipc=host \
     -e HARNESS_URL=http://<LAN-IP>:5173/dev/editor-harness.html \
     -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
     -v "$PWD:/work" -w /work \
     mcr.microsoft.com/playwright:v1.60.0-noble \
     node web/dev/webkit-render-check.mjs
   ```

**Gotchas that have bitten before:** a stale Vite from *another worktree* can
squat port 5173 (`lsof -ti tcp:5173`); `npm --prefix web` does **not** set cwd
(use `-w web`); the Playwright image tag must match the installed Playwright
version; and unexplained type errors in `web/` usually mean a **stale
`shared/dist`** — build `shared` first (`npm run build` does; `-w web` alone
doesn't).

## The CSP probe

The native webview's Content-Security-Policy
([security.md](security.md#the-native-webviews-csp)) is the one piece of
hardening whose failure mode is **silence**: a directive that is one source too
tight doesn't throw, it just leaves an avatar, an attachment, the voice worker or
the editor's stylesheet quietly missing. Reading the policy is not enough, and
jsdom enforces no CSP at all, so it is verified in real engines:

```sh
npm run build:web && node web/dev/csp-probe.mjs   # prod policy vs web/dist
npm run dev -w web && node web/dev/csp-probe.mjs --dev
```

Prod mode serves `web/dist` from a throwaway server that reproduces what Tauri
does at runtime — the policy as a header on HTML only, with a `'sha256-…'` per
inline `<script>` — so what is tested is the policy *as shipped*, not a stricter
fiction. Dev mode uses the header Vite sends and additionally loads the editor
harness, which is how CodeMirror's runtime `<style>` injection gets exercised.

Every run does both **Chromium** (≈ WebView2 on Windows) and **WebKit** (≈
WKWebView / WebKitGTK on macOS and Linux), collects `securitypolicyviolation`
events *and* console refusals, and exits non-zero on any violation. Beyond the
page load it exercises what a bare load never touches: `data:` and `blob:`
images, `blob:` media, the same-origin module Worker, a JS-injected `<style>`,
an inline style attribute, the bundled fonts, and — on the harness page —
whether CodeMirror's theme actually applied. `CSP=…` overrides the policy, which
is how you confirm the probe still *catches* things (drop a directive; the run
must go red).

The policy's invariants (no inline script, no network origin in `connect-src`,
`frame-src` matching `embedSrc`, dev differing from prod only in `connect-src`)
are asserted separately in `web/test/lib/csp.test.ts`, which runs in the ordinary
Vitest `web` project.

## The error-catalogue guard

`web/test/lib/errors.test.ts` treats `web/src/lib/errors/catalog.json` as a
contract rather than a comment, because the catalogue is both what the user is
shown and what the website publishes per code:

- every code is `SCREAMING_SNAKE` (so it is a stable URL slug), and every entry
  has a `readableName` that is a sentence rather than a restated code, plus a
  description, a cause and at least one step to fix — each with a minimum length
  so a too-thin entry fails the build;
- it scans all of `web/src` for `toastError('CODE')` and fails if any raised
  code is missing from the catalogue (an uncatalogued code would degrade to
  showing the user a bare identifier);
- `errorMessage()` falls back to the bare code instead of throwing;
- `VOICE_E2EE_UNSUPPORTED` specifically must explain the encryption tradeoff,
  since refusing the call is a choice the user did not make.

## Coverage gates

`npm run coverage` runs in CI with per-file thresholds in `vitest.config.ts`.
**The gate is currently stale and near-vacuous**: its `include` list still names
modules deleted with browser mode (`web/src/lib/chatCrypto.ts`, `recovery.ts`,
`stores/chat.ts`, `server/src/routes/chat.ts`, `session.ts`, `realtime.ts`), and
Vitest silently skips a threshold for a file it has no coverage data for — so
those per-file bars enforce nothing and the run passes regardless. What is
actually measured today is `server/src/db.ts`, `tagColors`, `theme`, `transfer`
and `livePreview`; none of the v8 surface (the `native*` wrappers, the Rust
core) is in scope. Re-pointing the gate at the v8 modules is unfinished work —
[roadmap.md](roadmap.md).

## Infra notes

- Test data is always disposable: a temp dir per relay test (`test/helpers/
  server.ts`), a fresh `mkdtemp` `DATA_DIR` per Playwright run — never the dev
  `./data`.
- The relay test helper defaults to `registrationMode: 'invite'` (the secure
  default) and makes a test opt in to `'public'`, so an accidentally-open relay
  can't pass unnoticed.
- Rate limits are set effectively unlimited in the shared helper so they don't
  interfere; rate-limit behaviour is covered explicitly in
  `server/test/routes.ratelimit.test.ts`.
- Playwright expects the relay to be **built** first (`npm run build`); CI does
  this in a separate step.
