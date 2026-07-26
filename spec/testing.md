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
| Vitest — projects `crypto`, `server`, `web` | `npm test` (root) | 659 tests across 102 files |
| Rust core | `cargo test` in `src-tauri/` | 83 tests |
| AKD sidecar | `cargo test` in `akd-sidecar/` | 10 tests |
| Playwright — relay over HTTP | `npm run e2e` | `e2e/voice.spec.ts` + `e2e/onboarding.spec.ts` |
| Editor harness (manual / scripted, not CI) | `web/dev/` | see below |

CI (`.github/workflows/ci.yml`) runs four jobs on every push: Vitest with
coverage (`npm run coverage`), Playwright against the built relay, a
production-image boot probe (catches deps pruned by `--omit=dev`), and
`cargo test --locked` for the Rust core. `native-build.yml` builds installers on
tag/dispatch only and runs no tests.

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

The native product is verified in four layers. **L1 is built. L2, L3 and L4 are
not built** — they are strategy recorded here so the design decisions aren't
lost, and the work itself lives in [roadmap.md](roadmap.md).

### L1 — Rust core unit tests (`cargo test`) · **built**

83 tests inside `src-tauri/src/`, module by module. This is where the security
core is proven, and it is deliberately the largest and cheapest layer:

- **Keys** (`keys.rs`) — wrap/unwrap round-trip with domain separation, group
  delivery-token determinism against the verifier's convention, recovery-code
  format + normalization.
- **Identity** (`identity.rs`) — per-relay identity is deterministic, distinct
  across relays and distinct from another MK's (cross-relay unlinkability);
  DM conversation ids are order-independent; derived identities sign and verify.
- **Vault** (`vault.rs`) — create then all three unlock paths (keychain,
  password, recovery code), wrong secrets rejected, the escrow bundle is opaque,
  the escrow fetch-auth key matches the stored hash, restore-from-escrow
  recovers the same MK on a fresh device, delivery tokens are stable across
  devices, and **MK is cleared on lock**.
- **Envelope** (`envelope.rs`) — seal/open verifies the sender; a wrong
  recipient cannot open; tampered ciphertext, wrong group key and unknown
  versions are rejected.
- **Protocol / message disposition** (`message.rs`, 19 tests) — encode/decode
  round-trip, decode rejects unknown versions and missing required fields, and
  the disposition matrix: a valid message ingests with a *verified* sender,
  version skew and unknown kinds buffer, unrecoverable items are discarded.
  Per-kind cases cover friend accept/confirm (terminal) and garbage, edit /
  delete / react carrying the verified actor, group add-member bumping the
  version, group invites carrying the group key, call offers, and KT gossip.
- **Store** (`store.rs`, 15 tests) — SQLCipher create/migrate/reopen, wrong key
  rejected, migrations idempotent on reopen, message + note FTS (including the
  note body projection), idempotent import batches, message paging/edit/delete,
  attachment rows through eviction, unread + activity ordering, reactions,
  group-key upsert, friend addressing, and KT state incl. split-view detection.
- **Blobs and attachments** (`blobs.rs`, `attachment.rs`) — atomic idempotent
  overwrite, **path-traversal ids rejected**, per-file distinct keys, the cache
  serving ciphertext without the relay, and self-correction when a row's file
  has vanished.
- **Accounts** (`accounts.rs`) — first run creates a default account, each added
  account gets an isolated directory, the registry survives reload.
- **Transport** (`relay_client.rs`, `relay_live.rs`, `voice_live.rs`) — the
  challenge signature binds the relay fingerprint, token refresh margin, WS URL
  scheme mapping (non-HTTP bases rejected *before* connecting), capped monotonic
  backoff, and frame classification/forwarding.
- **KT** (`kt.rs`) — signed-root verification against the relay's scheme, lookup
  proofs accepted / bad roots rejected, key history, and self-audit flagging
  only a key this device never minted.

### L2 — Rust integration: two cores against a real relay · **not built**

Two core instances driven in-process against a **real spawned relay**, walking
the whole path: register → friend → DM → deliver → ack → read. This is the layer
that would prove the pieces L1 tests in isolation actually compose, without any
UI in the way. Nothing like it exists today — the closest coverage is the
relay's own Vitest suite (server side only) plus L1 (client side only), and
nothing exercises both halves of a real conversation at once.

### L3 — Playwright against a faked Tauri IPC · **not built**

Run the real v8 UI in a plain browser by injecting a **stateful fake core** with
`page.addInitScript`, before any app code loads. This gets UI end-to-end
coverage with **no production code changes** — the app keeps calling
`invoke()`; only the far side is fake.

The seam is small and was checked against the installed `@tauri-apps/api`
(2.11.1):

- `isTauri()` reads `globalThis.isTauri` — the fake must set it, or
  `web/src/lib/native.ts` reports `isNative === false` and the UI takes no
  native path at all.
- `invoke()` calls `window.__TAURI_INTERNALS__.invoke(cmd, args, options)`.
- Push events (`nativeRelay`, `nativeKt`, `nativeVoice` all use
  `@tauri-apps/api/event`) go through `invoke('plugin:event|listen', …)` with a
  handler registered via `window.__TAURI_INTERNALS__.transformCallback`, so the
  fake must implement `transformCallback` to be able to *push* frames at the UI
  rather than only answer calls.

The fake must be **stateful** (conversations, messages, friends, vault status),
not a per-command stub: the flows worth testing at this layer are multi-step.

Rejected alternative: **`@tauri-apps/api/mocks` (`mockIPC`)**. It is the
official mock, but it mutates `window.__TAURI_INTERNALS__` in the *current* JS
context — that is Vitest/jsdom, i.e. Node. Under Playwright the app runs in the
browser, the wrong side of the process boundary, so `mockIPC` cannot be used
directly; `addInitScript` is the equivalent that runs in page context. (Its
mocking *shape* is still the model to copy.)

### L4 — real-shell smoke via a WebDriver-ish harness · **not built**

A thin smoke run against the **actual built app** — the real WKWebView/WebKitGTK/
WebView2 shell over the real Rust core — covering unlock → send → receive →
search. L3 can't catch shell-specific breakage (webview quirks, IPC permissions
in `src-tauri/capabilities/`, bundling), so a small L4 is the only thing that
does. It is deliberately kept small: slow, flaky-prone, platform-bound.

### The constraint that shapes L3 and L4

`tauri-driver` — the official WebDriver path — **supports Linux and Windows
only**. Apple ships no WebDriver for WKWebView, so there is no official way to
drive the macOS build, and macOS is the primary development machine. That single
fact is why the strategy puts the load-bearing UI coverage in **L3** (a plain
browser + a faked IPC, which runs anywhere) and keeps **L4** to a smoke run that
may only be runnable in CI on Linux/Windows.

`@srsholmes/tauri-playwright` (MIT, pre-1.0, ~39 GitHub stars) claims an
all-platform socket bridge between Playwright and a running Tauri app and is
worth evaluating for L4 — with eyes open about taking a pre-1.0, single-author
dependency into the test path.

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
  signature + version anti-rollback), group send/blobs, blobs, escrow, push
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
  left ringing), while **hang-up is never blocked**.

`jsdom` limits what this layer can claim: it has no layout (see the editor
harness below) and no canvas, so `imageOptimize` is not unit-tested there.

## The relay Playwright suite

`npm run e2e` boots the **built relay** (`node server/dist/relay-index.js`) on a
throwaway `DATA_DIR` and drives it over real HTTP. Both specs are API-level —
there is no SPA to navigate:

- `onboarding.spec.ts` — `/api/health`, and the pinned-identity handshake:
  `/api/relay/info` must report a fingerprint that is genuinely the SHA-256 of
  the advertised identity key (not an unrelated or empty string), and it must be
  stable across calls so the client's pin cannot drift mid-session.
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
