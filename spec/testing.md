# Test plan — Vitest + Playwright

A plan for a unit + integration + e2e suite covering everything shipped (notes,
crypto, auth, themes, attachments) and v3 phase-1 chat. Nothing here is built
yet; this is the blueprint and priority order.

## Tooling

- **Vitest** for ALL unit + integration tests — frontend **and** server. Vitest
  is a general Vite-powered Node test runner, not browser-only: it runs the
  Fastify server, the `better-sqlite3` layer, and the WebCrypto/`@noble` code
  directly under Node. (So yes — Vitest is the right tool for the Node/server
  side too; no separate runner needed.) One Vitest project per workspace:
  - `server` — `environment: 'node'`.
  - `web` — `environment: 'jsdom'` (already a devDep) for DOM/store/editor tests.
  - `shared` — `node` (mostly type-level; a few crypto helpers if any move here).
- **Playwright** for end-to-end: real Chromium + WebKit, real WebAuthn via the
  **virtual authenticator** (see the auth seam note below).
- Root `npm test` runs all Vitest projects; `npm run e2e` runs Playwright. CI
  (GitHub Actions) runs both on push.

## Layer A — crypto unit (Vitest, node) · **P0**

The security core; cheapest, highest-value tests.

- `crypto.ts`: `wrapKey`/`unwrapKey` round-trip + wrong-key/tamper rejection;
  `sealKey`/`unsealKey` round-trip (and unseal with the wrong keypair fails);
  HKDF determinism + domain separation (different `INFO_*` → different keys);
  recovery-code derivation; `generateKeyPair`, `sha256b64`, base64 helpers.
- `chatCrypto.ts`: conversation-key gen/seal/unseal; `encryptMessage` /
  `decryptMessage` round-trip over a `MessagePayload`; ciphertext tamper → throw;
  a key sealed to A cannot be unsealed by B.

## Layer B — server (Vitest, node) · **P0**

- **DB accessors** against a fresh `better-sqlite3(':memory:')` per test (the
  agent already proved this works for an ad-hoc script — formalize it):
  users + `display_name`/effective-name; invite → redeem → request → accept →
  two-way friends; **seq monotonicity**; **`dm_key` uniqueness**;
  `purgeExpiredInvites` (lazy + sweep); `last_read_seq` never decreases; unfriend
  removes both rows.
- **Routes via `app.inject()`** (Fastify's in-process HTTP — no network). A
  helper seeds a user + a `sessions` row and sets the `notes_session` cookie to
  get an authenticated request **without** a passkey ceremony (the auth seam).
  Cases:
  - Auth: every chat route → **401** unauthenticated.
  - Friends: redeem rejects own/expired/duplicate; accept only by recipient;
    decline by either party; invite delete scoped to owner.
  - DM: `POST /conversations/dm` idempotent on `dm_key`; members must be exactly
    {me, friend}; **IDOR** — a non-member gets 403 on messages/read/history;
    **unfriend revokes** (after `DELETE /friends/:id`, the DM's message routes
    return 403 and it drops out of `GET /conversations`).
  - Messages: send assigns the next `seq`; backfill DESC + `before` pagination;
    read marker advances and fans out.
- **WebSocket hub** (`realtime.ts`): `app.listen()` on an ephemeral port + a `ws`
  client. Assert: no-cookie/bad-Origin upgrade is rejected (no `hello`); `hello`
  on authed connect; **fan-out** — two authed clients in one DM, a REST send
  reaches both; presence on connect/disconnect; per-user cap evicts oldest. (Unit
  the hub's `sendToUsers`/`isOnline` with fake socket objects for the edge cases.)

## Layer C — web unit (Vitest, jsdom) · **P0–P1**

- **Stores with `api` mocked** (regression-lock the bugs fixed in review):
  - `chat.openDm` derives the conv key from the server-returned `sealedKey`, not
    the locally-generated one (idempotent-DM case). **P0.**
  - inbound `message` for an unknown conversation triggers `loadConversations()`
    and surfaces the conversation. **P0.**
  - `sendMessage` optimistic append + WS echo **dedupe by `seq`**. **P0.**
  - `markRead` never moves the marker backward; `unreadCount = lastSeq − lastRead`.
  - `friends` store: accept/decline/redeem state transitions; `handleFrame`
    friend-request/accepted/presence updates.
- **Editor (headless CodeMirror, jsdom)** — convert the existing ad-hoc harnesses
  into Vitest: building decorations over tasks + a table never throws
  (`RangeSet.of` sort tiebreak); `##` empty heading doesn't disable the plugin;
  checkbox toggle flips `[ ]`↔`[x]`; table cell edit rewrites the right source;
  `concealedMotion` moves one visible char per arrow press.
- **Pure libs:** `transfer` export/import converters (as-is/obsidian/standard/
  plain round-trips); `tagColors` (WCAG luminance pick); `theme` (mode/palette
  resolution, the inline-script ↔ `theme.ts` agreement). `imageOptimize` needs a
  real canvas (jsdom lacks one) — either skip in jsdom or run that file under a
  `node-canvas`/browser-mode Vitest project; flag as best-effort.

## Layer D — web components (Vitest + Vue Test Utils) · **P2**

Targeted, not exhaustive: `MarkdownView` renders tokens with **raw HTML inert**
(a message containing `<script>`/`<img onerror>` renders as text, executes
nothing) — the key security assertion; `ConversationPage` aligns own vs other
messages and renders an undecryptable message's fallback; `AppSidebar`
collapse/expand + unread badge.

## Layer E — end-to-end (Playwright) · **P2**

Run against a real built server + web with a temp `DATA_DIR`, seeded.

- **Auth seam:** prefer Playwright's virtual WebAuthn authenticator
  (`CDPSession` → `WebAuthn.addVirtualAuthenticator`). **Risk:** the PRF
  extension (which we need to unwrap MK) may not be supported by the virtual
  authenticator. Fallbacks, in order: (1) drive the **recovery-code** login path
  for E2E (no PRF needed); (2) an env-gated test-only login endpoint that seeds a
  session + injects a known MK. **Built (fallback 2, session-only):**
  `POST /api/test/session` (`server/src/routes/test.ts`) mints an authenticated
  session without the passkey ceremony — HARD off unless `config.testAuth`
  (`E2E_TEST_AUTH=1` **and** `NODE_ENV!=='production'`), and the module refuses
  under production regardless. It seeds no MK yet (voice/device-token E2E doesn't
  need one; a chat-oriented MK-seed extends it later).
- **Flows:** admin bootstrap → invite → register (recovery code shown once) →
  login / lock / unlock; notes CRUD + autosave indicator; live-editor formatting
  (type `**bold**`, assert markers concealed; shortcuts; a table + a checkbox);
  theme switch (assert computed background changes, no FOUC); attachment upload +
  inline render; export→import round-trip.
- **Headline chat E2E (two browser contexts A + B):** A generates an invite → B
  redeems → A accepts → A opens a DM and sends a message → **B receives it live**
  over the socket → unread badge on B → B opens and the marker clears. This is
  exactly the "not yet verified" gap from [chat.md](chat.md) and the most
  valuable single test.

## Priority order

- **P0** — crypto + chatCrypto unit; server db + route(inject) tests (auth, IDOR,
  idempotency, unfriend, seq); chat/friends store regression tests.
- **P1** — WS hub integration; editor headless tests; transfer/theme/tagColors.
- **P2** — Playwright onboarding + notes + the two-user chat flow; key component
  tests.
- **P3** — coverage gates in CI (high bar on crypto + routes + stores; lighter on
  components), WebKit/Safari run, perf/load smoke for the socket.

## Infra notes

- Test DBs: `:memory:` for unit, a temp dir for E2E; never the dev `./data`.
- The **auth seam** (seed session cookie for inject tests; recovery-code or
  test-login for E2E) is the one shared helper to build first — it unblocks all
  of Layer B and E.
- Add `vitest`, `@vitest/coverage-v8`, `@vue/test-utils`, `@playwright/test` as
  dev deps; remove the ad-hoc `jsdom`/`tsx` harness pattern once Vitest lands.

## v8 additions

New layers the local-first rework requires ([relay.md](relay.md),
[local-store.md](local-store.md), [native-app.md](native-app.md)).

- **Layer F — Rust core unit (`cargo test`) · P0. Built.** The largest v8 suite:
  crypto and key derivation (wrap/unwrap, per-relay identity determinism +
  cross-relay unlinkability, delivery tokens), SQLCipher open/reopen/wrong-key,
  schema migrations (idempotent, forward-only), the envelope and message
  disposition matrix, group state, KT verification cores, and the blob store
  (including a path-traversal guard). Run with `cargo test` in `src-tauri/`;
  the AKD sidecar has its own suite in `akd-sidecar/`.
- **Layer G — multi-device sync simulation · not built.** Two+ headless cores
  against an in-process mock relay: at-least-once delivery + dedupe by message
  id, tuple ordering (same-ms tiebreak, cross-relay clock skew), offline
  queue/drain, tombstone delete-wins, evicted-watermark no-refetch, multipath
  failover.
- **Layer H — CRDT convergence properties · not built.** Property tests that
  random concurrent op interleavings converge to identical state on all
  replicas.
- **Layer I — relay integration (Vitest `server` project) · P0. Built.** The
  sealed-send auth matrix, registration modes and invite gating, handle change,
  group-state signature + version anti-rollback, escrow endpoints, KT
  publish/lookup against a fake sidecar, blob routes, and the content-free push
  wake.
- **Layer J — KT auditor · P1. Built.** `ktAudit.ts` + `ktAuditCli.ts` detect a
  rewritten or stalled root chain against fixture logs.
- **Layer K — native e2e (tauri-driver/WebDriver) · not built.** Unlock → send →
  receive → search smoke against a real built app.

**Voice** has a Playwright spec driving two device-token peers against a real
mediasoup worker (`e2e/voice.spec.ts`). It depends on a **hard-off-by-default**
test-auth seam: `E2E_TEST_AUTH=1` **and** `NODE_ENV !== 'production'`, with the
module refusing to load under production as defence in depth, and the route
returning 404 whenever the flag is unset. The in-browser media round-trip is
deliberately not covered — see [voice.md](voice.md).

## The WebKit editor harness

The editor conceals Markdown markers as **atomic** ranges, so visual caret
motion depends on layout geometry that **jsdom does not model** — a Vitest case
can pass while a real browser misbehaves. `web/dev/` mounts the real
`<MarkdownEditor>` with no auth or stores so caret behaviour can be observed for
real; `web/dev/README.md` documents day-to-day use.

`web/dev/webkit-render-check.mjs` additionally drives that harness in **Linux
Chromium vs Linux WebKit** (the engine Tauri uses on Linux), doing a
caret-offset parity check, a per-construct probe, and screenshots. This is the
check that cleared Tauri for the editor, and it is worth re-running after
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
version; and "type errors" in `sw.ts` usually mean a **stale `shared/dist`** —
build `shared` first (the root `npm run build` does; `-w web` alone doesn't).
