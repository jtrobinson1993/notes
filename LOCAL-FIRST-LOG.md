# Local-first migration — work log

> **Working instructions (read me first — you are the assistant resuming this work):**
> - We're working through the **v8 decisions (D1–D12)** in `spec/roadmap.md`, one at a time.
> - **Keep this log current** as decisions land / code changes — but **be succinct**: bullets,
>   informal prose, short. Don't bloat it (or your replies) — this file is context you'll re-read.
> - On a fresh context: read this log top-to-bottom to resume, then continue the decisions.

Running log for the **v8 local-first** rework (spec: [`spec/roadmap.md`](spec/roadmap.md)
§ "v8 — Local-first across minimal relays"). Durable memory across context clears.
Newest entries at the top of each section.

## How to resume (fast context for a cold start)

- **Goal:** move durable data onto the user's own devices (native apps, local
  encrypted store), shrink the server to a zero-at-rest relay, sync via CRDTs.
  See roadmap decisions D1–D12.
- **Where things live:** decisions + rationale in `spec/roadmap.md`; crypto model
  in `spec/accounts-and-crypto.md`; this file tracks *what's done*.

### Re-running the WebKit editor harness (the D1 gate)

Validates the real editor renders/behaves under Linux WebKit (the engine Tauri
uses on Linux). Reusable as the app changes.

1. Dev server, bound so a container can reach it (Vite **403s** the
   `host.docker.internal` Host header — use the host **LAN IP** instead):
   ```sh
   npm run dev -w web -- --host 0.0.0.0 --port 5173   # note: -w web, so cwd is web/
   ```
2. Docker is **Colima**-backed; start the VM if `docker` errors on the socket:
   ```sh
   colima start --cpu 4 --memory 4
   ```
3. Run the harness in the Playwright Linux image (find the host LAN IP from the
   Vite "Network:" line, e.g. 192.168.1.158):
   ```sh
   docker run --rm --ipc=host \
     -e HARNESS_URL=http://<LAN-IP>:5173/dev/editor-harness.html \
     -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
     -v "$PWD:/work" -w /work \
     mcr.microsoft.com/playwright:v1.60.0-noble \
     node web/dev/webkit-render-check.mjs
   ```
   Outputs caret-parity results + `web/dev/out/*.png` screenshots (throwaway).

**Gotchas hit (so they don't bite again):** a stale Vite from *another worktree*
can squat port 5173 (`lsof -ti tcp:5173` to find it); `npm --prefix web` does NOT
set cwd (use `-w web`); the Playwright image tag must match the installed
Playwright version (currently 1.60.0).

## Decisions locked

- **D3 / D3a — Local unlock.** OS keychain + biometric = **primary** local
  unlock on native shells; **PRF optional per-platform, never load-bearing**;
  **password (Argon2id) = portable cold-start path**; recovery code retained.
  **D3a: passwordless cold-start on a fresh, unpaired device is NOT required** —
  such a device has no local history anyway (history lives on devices, D8), so
  password-as-insurance + QR device-linking (D8) is the model. This removes any
  need for robust cross-platform PRF, so weak Linux-desktop PRF is a non-issue
  (consistent with the D1 choice). Written into roadmap D3 + new D3a.
- **D12 — Trust / distribution.** **Adopted:** signed, store-distributed native
  app + **reproducible builds** (verify shipped binary vs public source) — the
  answer to the served-code problem. **Web client kept** as an **opt-in,
  explicitly-labeled lower-trust linked client** (reduced/online-only, no full
  local history per D2) with an **upfront trust caveat** (its E2E crypto runs in
  server-delivered JS). Two tiers, for zero-install access + easier transition.
- **D11 — Chat.** Messages append-only, immutable, ordered by `seq` (no CRDT) +
  relay-independent id (D4c); groups need relay fan-out. **Mutable overlays in a
  per-conversation Yjs doc:** edits = **LWW register** (single-author); reactions =
  **add-wins CRDT set**; read state = **monotonic max**; **deletion =
  delete-for-EVERYONE only** (NO delete-for-me) via propagating **tombstone**
  (delete-wins, content GC'd after convergence — tombstone stops offline-resync
  resurrection), renders as **"message deleted" placeholder**; typing/presence =
  ephemeral. (User: no delete-for-me; show deleted placeholder.)
- **D10 — Notes.** Shared notes live per-device under the per-note key; relay
  forwards encrypted Yjs updates, stores nothing; fully offline. **Version history:
  coalesced ~10min auto-snapshots + named versions (kept indefinitely), generous
  disk-bounded cap** (vs today's server 50-max/10min), restore via History dialog.
  **Sync scope: FULLY synced incl. co-editors** (shared revision timeline). **New
  requirement (user): share flow must WARN that sharing a note also shares its full
  history.** Content always syncs via CRDT regardless — this is only past
  revisions. **Migration:** first-run pulls server notes → decrypt → seed Yjs docs
  in SQLCipher; best-effort import legacy server snapshots as read-only versions.
- **D8 — New-device onboarding + data loss.** Mechanics already specced (QR pair →
  sealed MK → bulk history stream → CRDT sync). **Mitigations for "lose all devices
  = lose history" — BOTH:** (a) soft **≥2-device onboarding nudge** (not enforced);
  (b) optional **user-initiated offline encrypted export** file (under recovery
  code, user-stored, **never server-side**) — restorable on a fresh device, the
  real safety net for total loss. Zero-at-rest preserved. *(Was skipped mid-session;
  caught in the consistency read-through.)*
- **D9 — Conflict model: Yjs (confirmed).** `y-codemirror.next` (app is CM6),
  fast large-text, Matrix-proven E2EE-over-relay. Encrypt binary update blobs
  (per-note / per-conversation key) → relay opaque. **Persist via SQLite/SQLCipher
  adapter** through the Rust core (not y-indexeddb — D2 dropped IndexedDB).
  Document caveat: conflict-free ≠ semantically perfect. Which state is CRDT vs
  LWW → decided per-surface in D10/D11.
- **D7 — Connectivity, voice & push.** Voice: relay keeps **STUN/TURN + mediasoup
  SFU** (unchanged). Push: **content-free** wake-signal, one abstraction fanning
  **web-push/VAPID + APNs + FCM**; sync = **push-wake + foreground** (not
  continuous). **Rich notifications via NSE (iOS) / bg handler (Android)** —
  fetches queued ciphertext + **decrypts on-device** (E2E kept; fine under
  sealed-sender). NSE has no biometric, so uses a **dedicated preview key** (NOT
  MK/content keys): sender encrypts a small preview blob to it, NSE decrypts only
  that → blast radius = **previews only**; graceful fallback to generic.
  **Notification-privacy toggle = real control** (picks preview key's keychain
  class): (1) **Rich always [DEFAULT]** = AfterFirstUnlock (lock-screen previews;
  key extractable while locked, previews-only); (2) Rich-when-unlocked =
  WhenUnlocked (generic on lock screen); (3) Generic = no NSE decrypt. + **per-
  conversation override**; fresh boot (BFU) always generic till first unlock.
- **D6 — Relay retention & transport.** **Mailbox:** hold ciphertext per recipient
  device until it **acks** → delete; all-ack → gone; **undelivered TTL ~30d**
  (offline-past-TTL device re-syncs from another own device, so ≠ data loss);
  **group** = one upload (group-key payload) → relay fans to per-member queues;
  **transport via relay, not P2P**. **Metadata: SEALED-SENDER in v8** — relay sees
  only **recipient+timing+sender IP**, not the sender. Reach gated by
  **delivery-token capability** (friend holds a token you issued via invite flow;
  relay checks token, not identity); friend-reqs via invite-redemption. *Honesty:*
  partial win — same IP for authed fetch + sealed send lets a relay still infer
  A→B by IP; removes the explicit logged sender field, not true anonymity (needs
  Tor/mixnet). **Blocking (no server block list):** 1:1 block = **unfriend → revoke
  token via profile-key rotation** (invite-only prevents re-add; deleting an invite
  code only cancels a *pending* invite); in-group block = **client-side hide**.
  **Rate-limiting = IP-based DoS only** (identity-free) — user's key point that
  killed the "rate-limit needs sender" objection; per-sender spam isn't a server
  need (block/unfriend + no stranger-reach). Follow-on: write token issuance +
  profile-key rotation into accounts-and-crypto.md when built. (User drove
  sealed-sender + block model.)
- **D5 — Key directory & MITM.** Relay serves `handle → X25519 key`, so a bad
  relay can swap a key + MITM. **Both defenses ship in v8:** (1) **per-relay
  key-transparency log** — append-only, privacy-preserving **AKD/CONIKS lineage**
  (engine behind WhatsApp KT / Apple CKV; lean on Meta's open-source **AKD**);
  clients auto-verify inclusion+consistency proofs and **self-audit their own
  binding** (you're the best auditor of your own key), catching equivocation for
  the 99% who never verify manually. (2) **SAS fingerprint verify** — out-of-band
  human compare, reuses device-link screen, **near-free**, trusts no server →
  covers the log's early **split-view** gap before an auditor/gossip ecosystem
  exists. Overrode my "defer SAS" lean: deferring the *cheap* anchor to ship only
  the *expensive* auto layer was backwards. Per-relay identities → per-relay logs;
  no cross-relay log (federation out). Track: **auditing-ecosystem maturity**.
- **D2 — Local storage engine.** **SQLite in the Tauri Rust core** (webview →
  async IPC → SQLite; filesystem for encrypted attachment blobs) — escapes browser
  quota/eviction, the point of going native; drops IndexedDB for the native
  durable store (a reduced web client could still use it — D12). **At rest:
  SQLCipher whole-DB** (rows/indexes/**metadata** encrypted; key in OS keychain,
  biometric-gated per D3) storing **usable data** so **local search works** —
  chosen over field-level ciphertext (which kills local search + leaves metadata
  in clear). E2E content encryption is **separate + mandatory** (protects relay/
  transit); SQLCipher only adds device-at-rest. Cost: refactor `idb.ts` → IPC.
- **D4b — Multi-relay auth, invites, contact continuity.**
  - *Challenge protocol:* relay issues a random **nonce**; device signs {nonce +
    **relay's own identity**} → no cross-relay signature replay; relay returns the
    short token (D4).
  - *Friend-invite codes:* self-describing {relay hint + relay key fp + one-time
    token}, **redeemed only in the app, never a browser**. Two carriers for one
    token — (1) **in-app**: known **prefix** rendered as a tappable "add friend"
    button (100% reliable, app-controlled); (2) **out-of-app**: **universal/App
    Link** with token+fp in the URL **`#fragment`** (never hits a server),
    installed app intercepts, inert "open in Accord" shim if not installed. No
    Referer/UA/cookie/fp leak; per-relay identity means no cross-relay identity
    exposure; residual IP correlation = general D6 concern.
  - **D4c — cross-relay contact continuity (persistent multipath), ADOPTED.**
    Permanently link a friend's identities across relays via an **E2E,
    relay-invisible "same-me" attestation** signed by an already-verified relay
    identity (→ **D5 verify-once**, no fresh SAS). **Additive, not migration:**
    contact reachable via {A, B, …}; A down → route via B onto the **one local
    thread** (history is local, so a relay dying never loses history — only the
    live channel). Relays still can't correlate (link is friend-to-friend only).
    Needs a **relay-independent message id** → folded into **D11**. Same
    signed-pointer trick handles a relay **URL change** (signed "moved-to" vs
    pinned key). Federation still out (1:1 + all-migrate groups only). **Build
    timing: full v8 scope** (failover routing + dedup + contact-link UI in v8);
    lands in phase 5 alongside D8.
- **D4 — Offline auth & use.** Two **independent** layers (this separation is the
  key insight). **(A) Vault unlock = user-facing per-device re-lock toggle**
  ("Stay unlocked" vs "Require unlock when device locks / after idle"); gates
  *reading* local data only. **(B) Relay token = short-lived, silently re-signed
  on the device key** (D4b) — no biometric prompt, minimal relay state, revocation
  works within the token window, leaked token self-heals. Chosen over a long token
  (which needs a server-side blocklist + stays valid until revoked). Payoff:
  because B refreshes on the device key (not the MK), the **relay stays connected
  for pushes/sync while the vault is locked** — you re-unlock only to read.
  Written into roadmap D4.
- **D1 — App framework: Tauri v2** (one shell stack across Win/macOS/Linux/iOS/
  Android; light binaries). **Fallback: Capacitor + Electron** if a blocker
  appears. The Linux-WebKit editor-render **gate passed** — caret-offset motion
  across concealed markers is identical to Chromium, and WebKit renders concealed
  markup correctly (a Chromium screenshot font-weight quirk was a headless-
  container font artifact, not an engine difference). Electron's ~150 MB/high-RAM
  weight was the deciding con; D3 defuses Tauri's weak passkey/PRF story.

## Decisions in progress / next

- **ALL v8 decisions D1–D12 are now locked** (plus sub-decisions D3a, D4b, D4c).
  See roadmap "Decisions to make" (each marked *decided*) + "Open questions"
  (each resolved, with residual sub-threads to track noted inline).
- **Residual sub-threads to track (not blockers):** key-transparency
  auditing/gossip-ecosystem maturity (D5); sealed-sender's partial protection vs
  IP correlation (D6, D4b); crypto-spec write-up of delivery-token issuance +
  profile-key rotation in `accounts-and-crypto.md` (D6); optional future global
  directory for same-handle-across-relays UX (D4b).
- **Next phase = implementation.** Roadmap "Suggested phasing" (6 phases) is the
  build order. Nothing committed yet — branch off `main` before starting code.

## Work completed

- **App typeface: Geist (Sans + Mono), self-hosted.** Added
  `@fontsource-variable/geist` + `@fontsource-variable/geist-mono` (bundled, no
  CDN — matches the icon privacy posture), imported in `main.ts`; set Tailwind v4
  `--font-sans`/`--font-mono` in `style.css` `@theme` (so the base font + every
  `font-sans`/`font-mono` utility, incl. inline code + code blocks, pick it up);
  pointed the editor's monospace syntax tag at `var(--font-mono)`. Geist chosen to
  pair with the geometric Myna icons and for its coordinated mono (code blocks).
  Verified rendering identical in Linux Chromium vs WebKit via the harness (needed
  a `document.fonts.ready` wait + pointing the harness root at `var(--font-sans)`
  instead of its old hardcoded `system-ui`, which had masked the app font).
- **Fixed an editor crash (pre-existing, not v8-specific):** a fenced code block
  threw `Block decorations may not be specified via plugins` in live preview
  (reproduced in Chromium too — engine-independent). Cause: `codeBlocks.ts`
  provided a block widget + line decorations from a **ViewPlugin**, which CM6
  forbids. Fix: converted to a **StateField** mirroring the existing `tableField`
  pattern in `livePreview.ts`. Verified via typecheck + harness (`fencedCode` now
  passes). Discovered by the D1 WebKit harness's construct probe.
- **Built the reusable WebKit render/caret harness:** `web/dev/webkit-render-check.mjs`
  — drives the standalone editor harness in Linux Chromium vs Linux WebKit, does a
  caret-offset parity check + per-construct probe + screenshots.
- **Roadmap consolidation:** merged the former split "v8 + v11" into a single
  **v8** milestone (header, internal cross-refs, README/SPEC version ranges);
  folded in two review flags — D8 now names the loss of v2's encrypted *server*
  backups as a deliberate regression, and `spec/README.md`'s tech-stack table
  notes v8 revisits the "no native apps" line.

## Housekeeping / loose ends

- Currently on **`main`** — branch before committing the migration work. Nothing
  committed yet this session.
- `web/dev/out/*.png` are throwaway screenshots — add to `.gitignore` (or don't
  commit). `web/dev/webkit-render-check.mjs` is worth keeping.
- Dev server may still be running on `:5173`; Colima VM may be running.
