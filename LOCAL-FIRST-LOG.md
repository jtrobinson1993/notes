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

- **ALL pre-implementation specs DRAFTED (list in roadmap now fully linked).**
  New files: **`spec/local-store.md`** (SQLCipher schema sketch, Rust core =
  headless client — storage+crypto+networking in Rust, webview = UI only,
  domain-level IPC commands, backup `.accordbackup` format:
  Argon2id+XChaCha20-Poly1305 over zstd tar, media toggle; DB `user_version` +
  CRDT `docSchema` versioning), **`spec/key-transparency.md`** (AKD/CONIKS via
  Meta `akd` crate + napi binding [confirm at build], VRF-blinded labels,
  heartbeat epochs, proof table, root gossip, .well-known roots JSON, reference
  auditor CLI = chain-verify + watch mode), **`spec/migration.md`** (T-0 ship /
  per-user pull-everything / **old-key-signs-new-key attestation** into KT
  genesis for the D4b identity switch / T+60 purge / straggler v2-format export
  +30d / rollback = legacy store read-only till purge; mixed period = app
  unusable till migrated, coordinate personally). Smaller: chat.md § v8 friends
  (invite-only supersedes request-by-handle), voice.md § v8 (device-token auth;
  multipath ring dedup by call id; media on relay that carried accepted offer),
  testing.md § v8 layers F–K, relay.md § envelope versioning (never-drop:
  buffer + "update app" placeholder). All indexed in SPEC.md + spec/README.md.
- **License: AGPL-3.0-only (DECIDED, applied).** `LICENSE` at root (canonical
  GNU text), `license` field in root/web/server/shared package.json, README
  License section, spec README repo row + roadmap bullet updated. User picked
  AGPL over MIT/Apache.
- **Relay wire/API spec DRAFTED → `spec/relay.md`** (new spec file, indexed in
  SPEC.md + spec/README.md). Contains: complete state inventory
  (durable/transient/never-stored tables), challenge/token auth, escrow
  endpoints, sealed-sender mailbox (send is deliberately UNauthenticated —
  delivery token is the only credential; ephemeral flag for typing/presence),
  blob store, directory+KT endpoints (+.well-known roots alias), signed
  group-state GET/PUT with version anti-rollback, invites, push, satellite QR
  link + device-served history forwarding, voice unchanged, IP rate limits.
  Payload shapes = design intent; finalize at build → becomes as-built ref.
- **D15 — account escrow + passkeys (DECIDED).** Consistency review caught a real
  contradiction: D3a password cold-start + D8 "recovery code restores identity"
  had **nothing to decrypt** on a stateless relay (no other device, no backup ⇒
  MK gone). **Fix: relay-held wrapped-MK escrow** — password-wrapped +
  recovery-wrapped MK (same blobs as shipped v1), registered on **every** relay
  you join (redundancy). Explicit carve-out: zero-*content*-at-rest (relay
  already persists directory/KT/verifiers/push tokens). Safe because Argon2id is
  client-side, password never transmitted (v1 already works this way — server
  stores only a domain-separated auth-key hash); native app closes the
  served-code hole; residual = offline brute-force of the password blob
  (Argon2id 19MiB/t2 + 16-char min; recovery blob 160-bit random = unbreakable).
  User asked the interception question, confirmed stance secure → option (a).
  **Passkeys RETAINED** (user: keep in addition to passwords) but re-scoped —
  today they're PRF-only (non-PRF rejected!); v8: (i) bootstrap/recovery *auth*
  where shell WebAuthn works (synced passkeys), (ii) opportunistic PRF wrap
  (web satellite), never load-bearing; (iii) day-to-day relay auth stays device
  key. Registration stops rejecting non-PRF passkeys. Password mandatory = the
  only universal decrypt factor absent reliable PRF.
- **Release strategy (DECIDED): ONE release.** All six phases land on this
  branch/PR; hard cutover on merge/ship; deployed app untouched until then.
- **Migration scope (DECIDED): everything we can** — notes + chat history +
  attachments + profiles + settings; stated in the runbook item.
- **Web satellite recent history (DECIDED): WhatsApp-Web model** — served by a
  linked native device over the relay; satellite shows history only while a
  linked device is online. Written into D12.
- **Crypto placement (DECIDED): Rust core.** Keys never cross IPC (= the
  Tauri webview↔Rust message channel); webview requests operations, never sees
  key material.
- **Media-codec licensing: DECIDED — LGPL ffmpeg, no GPL anywhere.** Key
  insight: ffmpeg's hardware-encoder *wrappers* are LGPL (encoding happens in
  OS/silicon) → one LGPL build covers all 5 platforms: h264_videotoolbox
  (macOS/iOS) / h264_mf (Win) / h264_mediacodec (Android) / h264_vaapi +
  **openh264 fallback** (BSD wrapper; Cisco prebuilt binary = their patent
  grant, Firefox model) on Linux. Output stays H.264+AAC MP4 720p30 (universal
  webview playback; VP9/AV1 spotty on iOS). LGPL obligations: dynamic link +
  notices + ffmpeg source pointer; app license unaffected. GPL analysis for
  the record: would've been workable for free self-hosting + ads/Patreon, but
  bundling libx264 into an iOS App Store app is a real license conflict (VLC
  precedent) → moot now.
- **Distribution channels: still DEFERRED** until after implementation (user
  call). Tauri updater key = security-critical.
- **REPO HAS NO LICENSE (flagged during ffmpeg discussion).** Repo is PUBLIC
  (gh confirms; spec table said "private" — fixed) with no LICENSE file ⇒
  all-rights-reserved: nobody may legally self-host despite that being the
  intent. Pick needed before v8 ships (also underpins D12 reproducible-build
  verification). Options in roadmap: AGPL-3.0 (self-hosted-app standard; sole
  copyright holder can dual-license own code for stores) vs MIT/Apache-2.0.
  **Awaiting user pick.**
- **v6 voice: MERGED to main (verified via merge-base).** User tested solo with
  two accounts — works; two-person audio-quality check still pending. Spec
  status updated (roadmap/SPEC/README). Branch cleanup: 19 merged remote
  branches identified for deletion (mass-delete was permission-blocked — user
  runs the command); `docs/device-linking-spec` left alone (PR #10 CLOSED, not
  merged — may hold unmerged spec content worth salvaging for D8).
- **D14 — group authority: DECIDED (owner + admins kept).** Signal (GroupsV2) =
  encrypted server-held group state + zkgroup anonymous credentials — zk part
  overkill for us (relay already learns membership via fan-out; posture = no
  *content/media*, user clarified). **Relay-held owner/admin-SIGNED membership
  record**, versioned vs rollback → keeps v4's shipped owner/admin roles (user:
  keep them; owner-only rejected — offline-owner blocks changes, owner loss
  freezes group), kills offline races, stores no content; relay learns which
  admin acted (documented trade).
- **Per-operator push keys: IMPOSSIBLE (D7 amendment #2).** User asked if relay
  operators can bring their own keys to avoid the gateway — no: APNs/FCM creds
  are bound to the *app* (bundle id / Firebase project), only the publisher's
  dev account can mint them; an operator would have to fork + distribute their
  own app (breaks D12 single signed/reproducible build). This app-binding is
  why Matrix built Sygnal. Partial exception: **Android UnifiedPush** (operator
  self-hosts a distributor, e.g. ntfy, once the app supports it); **iOS has no
  equivalent**. Gateway remains the post-v8 answer for third-party relays.
- **Ordering (D11 amendment).** Relay stamps arrival time (stateless, no
  counter); sort key = **(relayTs, senderId, msgId)**; **NO dense seq is ever
  derived** (devices hold different subsets — floors/eviction/mid-history
  pairing, so counting diverges); anchors = **message ids** (ReplyRef keeps its
  snapshot); read state = max (ts,id); multipath clock skew tolerated, dedupe by
  id; relay is trusted for *order* (documented trade). **Backfill integrity:**
  sender signs {id, conversation, content} inside the envelope (extends D6's
  identity cert) → a member serving history can't forge others' messages;
  **omission** is the residual. (User approved the outline as-is.)
- **D13 / D13a — key hierarchy + device revocation.** Derivation tree now in the
  roadmap (derived-from-seed = per-relay identity keys ONLY; everything that
  must rotate is random+wrapped). Revocation = **two tiers**: (1) lost-locked
  device → kill token refresh + rotate profile/conversation/note/preview keys
  (O(everything), same machinery as unfriend, applied at once); (2)
  compromised-**unlocked** device → attacker holds the seed → rotation can't fix
  derived identity keys → **new identity + SAS re-verify with contacts**. Note:
  "block" is not a mechanism — 1:1 block = unfriend→token revocation; group =
  client-side hide (user re-confirmed).
- **Push credentials (D7 amendment).** **No gateway in v8** — user isn't ready
  for extra infra, and none is needed: vendor = first-party relay operator, so
  the relay holds the APNs `.p8`/FCM keys in its gitignored `.env` (like KLIPY)
  and pushes directly. These are push-signing deployment secrets, NOT App Store
  credentials. Embedding keys in public source = rejected (extractable →
  push-spoofing). Sygnal-style gateway for **third-party relays = post-v8**
  (stateless, ~$5/mo when needed); until then third-party relays get no timely
  mobile wake. UnifiedPush = possible later Android path.
- **v9 — public chats (new roadmap section; post-v8 by user decision).** New
  distinct chat type, **NOT E2EE** (E2EE is theater in link-joinable rooms;
  plaintext → relay-served history, server-enforced admin, no rekey churn,
  scale) — deliberate *public-content* carve-out from zero-at-rest (posture =
  no *private* content/media). **Link-joinable** multi-use invite, no
  directory; **admission = owner/admin admits each joiner** (+ "admit all").
  Sender signatures still required. Open Qs punted into the section
  (moderation/operator liability, retention, scale ceilings, admin powers,
  identity exposure, friends-gate interaction, discovery).
- **D3 / D3a — Local unlock.** OS keychain + biometric = **primary** local
  unlock on native shells; **PRF optional per-platform, never load-bearing**;
  **password (Argon2id) = portable cold-start path**; recovery code retained.
  **D3a: passwordless cold-start on a fresh, unpaired device is NOT required** —
  such a device has no local history anyway (history lives on devices, D8), so
  password-as-insurance + QR device-linking (D8) is the model. This removes any
  need for robust cross-platform PRF, so weak Linux-desktop PRF is a non-issue
  (consistent with the D1 choice). Written into roadmap D3 + new D3a.
- **D12 — Trust / distribution.** **Adopted:** signed, store-distributed native
  app + **reproducible builds** (verify shipped binary vs public source). **Web
  client = lower-trust "linked satellite"** (flagged, crypto in served JS):
  **satellite-only** (QR-linked from a native device, never holds durable identity/
  MK — no standalone web), **in-memory only** (no persistence; shared-machine use
  case), **CAN** live chat + recent history + online note edit + voice, **CANNOT**
  full offline history / be a replica / backup export; **session-scoped TTL** (opt-in
  keep-linked; remotely unlinkable). **Migration = HARD CUTOVER at launch:** install
  native → sign in (server-verified bootstrap, provisions device key) → auto
  first-run migration (D10) → native-primary, web becomes satellite; standalone web
  disabled at launch, server data pullable a short window + export fallback, then
  purged. (User: hard cutover; asked how web-only users switch.)
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
- **Attachments / media (decided, under D6/D2).** Per-file key; ciphertext blob →
  relay **transient blob store** (hold-till-ack, zero-at-rest); key+metadata in the
  E2E message; **chunked+resumable**; inline encrypted thumbnail; on-device
  encrypted storage. **100 MB/file cap, 14-day blob TTL.** **Compression on send:**
  video → **720p30**, images → max dim/quality, default-on + "original quality"
  opt-out (bundled ffmpeg). **Local retention/storage mgmt (off by default, opt-in,
  LOCAL-only ≠ delete-for-everyone):** modes = downscale old media→360p / evict
  media keep messages / evict all > X days; manual clear; **per-device evicted
  watermark** blocks re-sync; on-demand rehydration if still available. (User asked
  for compression + retention.) Images **keep existing WebP pipeline**
  (`imageOptimize.ts` resize+WebP@0.82); video 720p30 is the new transcode.
- **Sealed-sender token mechanics (decided, D6).** Profile key = access root;
  **delivery token = KDF(profile_key,"delivery")**; recipient registers a
  **verifier (hash)** with relay; sender presents token, relay checks hash →
  authorizes without learning sender. Sender identity cert sealed *inside*
  ciphertext (verified vs D5 log). **Granularity: SHARED profile-key token** —
  relay never learns friend count; cost = block rotates profile key + re-issues to
  all remaining friends (Signal model). Group = analogous group token. Bootstrap
  via invite (D4b). Write full design into accounts-and-crypto.md at build.
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

- **New roadmap section: "Remaining pre-implementation spec work"** — the specs
  still to write, mapped to phases: relay wire/API spec + state inventory
  (security.md), D14 group state, SQLite schema + Rust/webview IPC boundary,
  friends-surface respec (invite-only supersedes friend requests), migration
  runbook, backup export format, KT log format, voice-under-v8, test-strategy
  addendum, envelope/CRDT versioning. Relay API spec = user-agreed next deep
  dive after these.
- **ALL v8 decisions D1–D12 are now locked** (plus sub-decisions D3a, D4b, D4c,
  and now D13/D13a; D11 ordering amended; D14 proposed).
  See roadmap "Decisions to make" (each marked *decided*) + "Open questions".
- **All former sub-threads / deferred items now SPECCED (nothing punted to
  implementation):**
  1. **Attachments** — per-file key, transient relay blob store, chunked+resumable,
     inline thumbnail, on-device encrypted storage, 100MB/14d; **compression**
     (images keep WebP pipeline, video→720p30) + **local retention policy** (opt-in,
     3 modes, evicted watermark).
  2. **Sealed-sender token mechanics** — profile-key access root, KDF delivery
     token + relay verifier, sealed identity cert; **shared token** (block = rotate
     + re-issue to all).
  3. **D5 gossip** — root-piggyback on E2E traffic + consistency check (split-view
     alarm) + well-known roots endpoint. **Auditors = INDEPENDENT third parties**
     (operator-run ones carry no trust value); v8 *enables* them (public roots +
     open-source reference auditor + log spec), doesn't operate them — and users
     already act as distributed auditors via gossip, so it's an enhancement not a
     dependency. **Build-time: add a "Verifying key transparency" section to
     README** with the independent-auditor recommendation.
  4. **Key-integrity warnings** — two-tier (soft inline / hard blocking).
  5. **Web tier** — lower-trust satellite-only, in-memory, voice-capable,
     session-TTL; **hard cutover** migration for today's web-first users.
- Only genuinely-post-v8 items left: IP-correlation mitigation (Tor/mixnet, out of
  scope); third-party transparency auditors; opt-in global same-handle directory.
- **UI surface section** in roadmap maps every decision to where it shows up; the
  two former *open* UI choices (key-warning severity, web boundary) are now resolved.
- **NOW walking through UI/UX design decisions** (new "### UI/UX design decisions"
  subsection in roadmap) — distinct from the D-decisions + the surface map. Areas:
  (1) multi-relay presentation, (2) nav shell, (3) onboarding/first-run/migration,
  (4) friends+invites+relay mgmt, (5) verification, (6) security settings,
  (7) storage/retention, (8) chat, (9) notes, (10) web satellite, (11) status.
  - **UI-1 — multi-relay = UNIFIED AGGREGATE (decided).** One inbox/friends/notes;
    relays = background; "via Relay X" only when relevant; relay mgmt in Settings.
    Matches D4c. **Forces:** contacts keyed on **verified identity not handle**
    (same handle can differ across relays) — D4c-linked merge, unlinked same-handle
    stay distinct w/ display-name/avatar/relay-tag disambiguation.
  - **UI-2 — nav shell = keep inherited (decided).** Top-level Notes·Chat·Friends·
    Settings, responsive rail/drawer; new v8 surfaces (Relays/Devices/Verification/
    Notifications/Storage/Backup) under Settings; no per-relay switcher.
  - **UI-3 — onboarding (decided).** Smart entry New/Existing. New: handle → unlock
    front-loaded (biometric+mandatory password+confirmed recovery code) → prominent
    skippable 2-device nudge. Existing: **pairing-first** (QR/SAS, brings history) ›
    fallbacks recovery-code / import-backup. Web migrant: sign-in → auto-migrate.
  - **Determined-by-derivation (locked, per surface map, no separate walk):**
    security settings, notification toggle, storage screen, chat surfaces, notes
    surfaces, verification badges/warnings, status, web gating.
  - **UI-4 — add-someone / connect-relay (decided).** Add-friend → 3-carrier invite
    (QR/link/in-app), relay-picker if multi; "I have an invite" paste/scan/tap;
    unknown-relay invite → inline "Join [relay]?" then add; manual relay add in
    Settings. **Relay self-names**; **welcome modal on join → set local nickname**
    ("Bob's server"). **Default relay DEFERRED** (may add first-party default(s)
    later; until then new user joins a relay during onboarding to mint handle).
  - **UI-5 — contact surface = PROMOTE TO FULL CONTACT PAGE (decided).** Today only
    `ProfileDialog.vue` (small modal: avatar/name/bio, read-only). Keep it as
    quick-peek + "View full profile" → new **full contact page**: identity ·
    verification (SAS + key warnings) · reachability (D4c relays/failover) · shared
    notes+groups · notif override · Block. (User corrected me: no contact screen
    exists today; it's the profile-pic modal.)
  - **UI walkthrough COMPLETE** (UI-1..UI-5 + determined-by-derivation set).
- **Branch:** committed + pushed to `origin/v8-local-first-decisions` (4 logical
  commits: docs, editor fix, fonts, harness). This UI+triage pass is a follow-up
  edit on that branch.
- **Next phase = implementation.** Roadmap "Suggested phasing" (6 phases) is the
  build order.

## Work completed

- **IMPLEMENTATION STARTED (phase 1) — Tauri v2 scaffold lands.** Running as a
  self-paced /loop; all phases on this branch per release strategy.
  - Installed Rust via rustup (1.96.1; `. ~/.cargo/env` needed in fresh shells).
  - `@tauri-apps/cli@2.11.4` dev-dep at root; `src-tauri/` scaffolded via
    `npx tauri init` — devUrl `localhost:5173`, frontendDist `../web/dist`,
    before-commands use `npm run dev/build -w web`. Identifier
    `dev.accord.app`, window 1200×800, Cargo metadata filled (AGPL). `cargo
    check` passes clean. Crate name left as template `app`/`app_lib` (cosmetic).
  - **Iteration 2 — D2 storage skeleton (DONE, 5/5 tests green, committed):**
    `src-tauri/src/store.rs` — SQLCipher whole-DB (rusqlite
    `bundled-sqlcipher-vendored-openssl`), schema **v1** = full local-store.md
    table set (FTS5 deferred to a later migration pending bundle support
    check), forward-only `user_version` migrations, wrong-key rejection;
    `src/vault.rs` — locked↔unlocked state machine, **password path only for
    now** (Argon2id m=19MiB/t=2/p=1, matching web `password.ts`; salt sidecar
    file; keychain/biometric primary + MK/D13 hierarchy come later — password
    currently derives the SQLCipher key directly, TODO noted in module doc);
    lib.rs exposes first IPC commands `vault_status/vault_unlock/vault_lock`
    with `Mutex<Vault>` managed state. Unit tests: roundtrip/reopen, wrong
    password, migration idempotency (cargo test running in background).
  - **Iteration 3 — webview bridge + PWA guard (DONE):** `web/src/lib/native.ts`
    (`isNative` via `isTauri()`, typed `vaultStatus/Unlock/Lock` invokes;
    `@tauri-apps/api` dep); VitePWA **disabled under Tauri** via
    `disable: !!process.env.TAURI_ENV_PLATFORM` (SW/manifest/install are
    web-only; tauri:// origin doesn't support SW anyway); **FTS5 confirmed
    available** in the sqlcipher bundle (new gate test — deferred FTS migration
    unblocked); cargo test 6/6. Gotcha: web build "type errors" in sw.ts were a
    **stale `shared/dist`** (build shared first — root `npm run build` does;
    `-w web` alone doesn't).
  - **Iteration 4 — D13 hierarchy + keychain unlock (DONE, 9/9 tests):**
    `keys.rs` (HKDF-SHA256 domain-separated wrap → AES-256-GCM; INFO_* strings
    `accord/mk-wrap/{vault-key,password,recovery}/v1`; 160-bit base32 recovery
    code, 8×4 groups, normalize on input) + `vault.rs` rework to the real tree:
    **random SQLCipher key + vault key in OS keychain** (`keyring` crate;
    entries namespaced `name@sha256(dataDir)[..8]`), **MK rests only wrapped**
    (vault-key / Argon2id password / recovery) in `vault.meta.json` sidecar;
    unlock paths = keychain (primary) / password / recovery; `create()` returns
    the recovery code once. IPC: + `vault_create`, `vault_unlock_keychain`,
    `vault_unlock_recovery`; native.ts updated. **Keychain is a trait**
    (OsKeychain prod / MemKeychain tests — keyring's mock doesn't share state
    across Entry instances, bit me). Biometric ACL gating (Secure Enclave
    access control) = later per-platform hardening; storage layout already
    matches D13. Note: DB file copied to another machine is unreadable by
    design (SQLCipher key never leaves keychain) — new devices pair or restore.
  - **Iteration 5 — FTS search + D4b identities (DONE, 13/13 tests):**
    store migration **v2** — `messages_fts` + `notes_fts` (FTS5
    external-content + sync triggers; `notes.search_text` added as the
    plaintext Yjs-body projection the notes engine writes on save);
    `identity.rs` — per-relay identity = HKDF(MK, domain|relay_fp) →
    Ed25519 signing + X25519 sealing (`accord/relay-id/{ed25519,x25519}/v1`);
    tests prove determinism, cross-relay unlinkability, sign/verify.
  - **Iteration 6 — import ingestion, Rust side (DONE, 14/14 tests):**
    `import_notes/conversations/contacts/messages` IPC commands + store batch
    methods — transactional, **INSERT OR IGNORE idempotent** (retry-after-
    partial-failure safe; OR REPLACE would desync the FTS triggers), notes
    carry a webview-built Yjs binary (`ydoc_state`) into `crdt_docs` (no yrs
    dep needed — core treats doc state as opaque). native.ts typed wrappers +
    batch interfaces. Design: legacy decrypt stays in webview TS (v1 crypto
    reuse per migration.md); core ingests plaintext batches over IPC.
  - **Iteration 7 — webview migrator (DONE, 6 new tests; suite 781 green):**
    `web/src/lib/migrate.ts` — `runLegacyMigration(mk, keyPair, onProgress)`:
    notes via `api.notes(0)` → `decryptNotePayload` → **Yjs doc seeded
    webview-side** (`yjs` dep added; `Y.Text('content')` matching the future
    y-codemirror binding) → batched `importNotes`; friends → contacts;
    conversations + full history paged (`before`/limit 200) → per-epoch keys
    unsealed once per conv → `decryptMessage` → batched import. Legacy msg id
    = `legacy:{convId}:{seq}`; general channel → NULL channel_id; tags folded
    into search_text; undecryptable rows skipped (epoch floor / corrupt).
    Pure mappers (`toImportNote/toImportMessage/noteBodyToYdocState`) unit-
    tested in `web/test/lib/migrate.test.ts`. **Deferred from this pass:**
    shared-with-me notes, attachment blobs (need encrypted-FS layer),
    settings/folders blob, profile blobs.
  - **Iteration 8 — native gate + migration UI (DONE; suite 786 green, 5 new
    component tests):** `NativeGate.vue` wraps `<RouterView>` in App.vue —
    browser slots straight through; native: uninitialized → password setup
    (16-min) → **recovery-code display (shown once, confirm)** → ready;
    locked → **silent keychain attempt** → password/recovery fallback form.
    `MigrationPrompt.vue` overlay: shows when native + legacy session
    unlocked + `migration.done` unset (vault-DB settings via new
    `settings_get/set` IPC); runs `runLegacyMigration(session.mk, keyPair)`
    with stage/progress display; retry-safe; stores summary. Design: gate
    does NOT intercept legacy auth — login/setup pages render normally under
    it, migration overlays once mk is present.
  - **Iteration 9 — attachment blob store (DONE, 18/18 cargo tests):**
    `blobs.rs` — dumb byte store for attachment **ciphertext as it travels**
    (per-file key stays in the SQLCipher `attachments` row; no re-encrypt);
    two-level sharded paths, atomic tmp+rename writes, id charset guard
    (path-traversal test), delete-on-evict. Store: `insert_attachment` /
    `attachment_meta` / `set_attachment_state` (evict NULLs path). IPC:
    `attachment_put/get/evict` (+ native.ts wrappers; get returns meta +
    bytes|null when evicted). Vault owns `BlobStore` at `dataDir/blobs`.
  - **Iteration 10 — migrator attachment pass (DONE; cargo 18/18, migrate
    tests 7/7):** store migration **v3** (`attachments.iv` — legacy AES-GCM
    blobs carry an external IV in their ref); `collectBlobRefs` gathers refs
    during the note+message passes (**video posters = separate blobs**);
    final 'attachments' stage downloads via `api.attachmentDownload`, skips
    already-imported (`attachment_has` probe), stores ciphertext as-is with
    key+iv in the row; missing/expired server blobs are non-fatal (ref stays,
    renders unavailable). Migration scope now: notes+tags, friends, convs,
    full history, attachments+posters. Still deferred: shared-with-me notes,
    settings/folders blob, profile blobs.
  - **Iteration 11 — D4 idle re-lock (DONE; suite 791 green; landed with
    iter-10 in ae22ec3 once 1Password unblocked):** `nativeVault.ts` —
    **shared gate state** (moved out of NativeGate.vue so re-lockers can flip
    the wall), `initGate/markUnlocked/lockVault`, `relock.policy`
    ('stay' default | 'on-idle') + `relock.idleMinutes` (default 15) read
    from vault-DB settings, idle timer with pointer/key/wheel activity reset,
    teardown on lock. OS device-lock detection = per-platform follow-up
    (macOS lock notifications / mobile lifecycle). 4 new tests (fake timers).
    Gotcha: chaining vitest with git in one command produced a flaky partial
    run (1 "failure", 99 files) — clean re-run 103/791 green; don't chain.
  - **Iteration 12 — device-lock Settings UI (DONE; web project 425 green):**
    `settings/DeviceLockSettings.vue` (native-only, rendered at the top of
    Settings → Security): policy select Stay-unlocked / Lock-when-idle +
    minutes input (saves to vault-DB settings, re-arms `applyRelockPolicy`
    immediately) + **Lock now** button (`lockVault`). SettingsPage change =
    import + a 4-line `v-if="isNative"` block.
  - **Iteration 13 — shared-notes + org-settings migration (DONE; cargo
    18/18, web 426 green):** store migration **v4** (`notes.note_key` —
    every note's E2E key retained: own = `unwrapNoteKey(mk)`, shared =
    unsealed `noteKeyRaw`; needed again for phase-4 relay sync under
    per-note keys). `migrateSharedNotes` (api.sharedNotes →
    decryptSharedNotePayload; `shared_json={owner,access}`; unsealable =
    skipped non-fatal; attachments collected). `migrateOrgSettings`
    (api.settingGet('notes-org') → unwrap INFO_SETTINGS → vault setting
    **`org.data`** verbatim — folder assignment stays in the org blob like
    the live app; notes.folder_id not materialized). New stages/summary
    fields + prompt labels.
  - **Migration scope now complete EXCEPT profile blobs** (own bio/avatar +
    contact profile cache — server purge would eat them; migrate next) and
    note version history (D10 says best-effort legacy snapshots as read-only
    versions — decide whether to pull `/api/notes/:id/versions` during
    migration).
  - **Iteration 14 — profile + note-version migration (DONE; cargo 18/18,
    web 426 green):** store migration **v5** (unique index on
    note_versions(note_id, kind, created) → INSERT OR IGNORE dedupe on
    re-run) + `import_note_versions` IPC. `migrateOwnProfile` — profileDataGet
    → unwrapProfileKey(mk) → decryptProfile → vault settings `profile.own`
    (plaintext JSON), **`profile.key` (b64)** (matters: becomes the D6
    delivery-token access root), `profile.epoch`. `migrateNoteVersions` —
    per own note: /versions list → each decrypted like a NoteRecord → kind
    'legacy' snapshots (JSON {title,body} bytes), best-effort per note (D10).
    Contact profile blobs deliberately NOT migrated: contacts redistribute
    their own profiles post-cutover; display-name cache already in contacts.
    **THE LEGACY MIGRATION IS NOW SCOPE-COMPLETE** (notes+keys, shared notes,
    versions, org settings, own profile+key, friends, convs, full history,
    attachments+posters).
  - **Iteration 15 — phase 1→2 review + D12 starter (DONE).**
    **Phase review vs roadmap phasing (honest):**
    - Phase 1 "native shells": desktop ✓; **mobile targets NOT initialized**
      (`tauri ios init` / `tauri android init` — needs Xcode/Android SDKs on
      this machine; queue for a desk session with the user).
    - Phase 1 "move durable storage to local SQLite": store/vault/blobs all
      exist ✓ BUT **the UI still runs on server+idb** — the big D2 refactor
      (notes.ts + session.ts stores read/write via IPC when isNative) is
      **unstarted and is the next major arc**. Migration fills the store;
      nothing reads it yet.
    - Phase 1 "import on first run": ✓ scope-complete (iter 7–14).
    - Phase 1 "code-signing + reproducible builds": started this iteration
      (below); signing waits on the deferred distribution-channel decision.
    - Phase 2 "local offline unlock": ✓ effectively done (keychain primary /
      password / recovery, re-lock policy + UI). Remaining hardening:
      biometric ACLs (Secure Enclave access control) per platform; relay
      token (D4 layer B) belongs to phase 3.
    **D12 starter:** `src-tauri/rust-toolchain.toml` (pin 1.96.1); ci.yml +
    `rust-core` job (cargo test --locked, rust-cache); new
    **`.github/workflows/native-build.yml`** — 3-OS matrix (mac arm64 /
    linux / windows), pinned toolchains, SOURCE_DATE_EPOCH from commit,
    unsigned bundles + SHA256SUMS artifacts, signing hooks commented, and a
    **repro-canary job** (same-machine double build, hash diff → warning
    until determinism work lands).
  - **Iteration 16 — notes CRUD, Rust side (DONE, 19/19 cargo):**
    store methods `list_notes / get_note / create_note / save_note /
    delete_note / search_notes` (FTS rank) + IPC `notes_list / note_get /
    note_create / note_save / note_delete / notes_search` + native.ts
    wrappers. Save = full encoded Y.Doc state + title + search projection
    (delta persistence arrives with phase-4 sync); webview owns the Y.Doc.
    Gotcha fixed: delete_note FK order (versions → note → crdt_doc; doc_id
    captured first).
  - **Iteration 17 — NOTES ARE LOCAL-FIRST IN THE SHELL (DONE; cargo 19/19,
    web 430 green):** store migration **v6** (`notes.tags_json` — tags become
    first-class; migrator populates it) + `notes_load_all` bulk IPC (startup
    = one call). `lib/nativeNotes.ts` — Y.Doc-per-note owner (hydrate from
    state; body edits = coarse replace in one transaction → single doc
    lineage until phase-4 collab; encode → save with title/tags/search).
    `stores/notes.ts` branches on isNative: loadFromCache → SQLite bulk;
    sync → local no-op (store IS the truth; relay = phase 4); save/create/
    remove → native fns (optimistic map update kept); **sharing guarded** in
    native (`guardNativeSharing` throws "returns with relay sync" — local
    edits would silently diverge from stale server ciphertext otherwise);
    reset clears docs. Browser path byte-identical. 7 new tests
    (nativeNotes hydration/save-roundtrip/lineage).
  - **Iteration 18 — chat-history primitives, Rust side (DONE, 20/20
    cargo):** `messages_page` — backward paging by the **D11 sort key**
    `(relay_ts, sender, id)` with an exclusive `(ts,id)` row-value cursor
    (test proves order + no-overlap continuation); channel_id NULL = general
    channel; limit clamped ≤500. Live-ingest surface for the interim
    (legacy WS still transports): `messages_ingest` (idempotent batch =
    import_messages), `message_edit` (content+edited_at in place),
    `message_delete` (content dropped, row stays as tombstone placeholder —
    D11 rendering). native.ts wrappers (`messagesPage/messagesIngest/
    messageEdit/messageDelete`).
  - **Iteration 19 — chat history local in the shell (DONE; web 434 green,
    tc clean):** `lib/nativeChat.ts` — `viewToRow/rowToView` (extras bag
    {attachments,gif,system,linkPreview} in one JSON column — **migrator
    updated to match: system events now survive migration**, previously
    lost); `loadHistoryLocal` with per-channel (ts,id) cursors + exhaustion;
    `teeMessage/teeEdit` fire-and-forget. chat.ts: `loadHistory` reads the
    local log when isNative (fresh open resets cursor); live WS 'message' /
    'message-edited' + sendMessage/editMessage all tee into the log. Ids
    keep the `legacy:{conv}:{seq}` composition → tees dedupe with migrated
    rows. Reactions/read-state stay in-memory until the phase-4 Yjs overlay.
    5 new tests (round-trip, tombstone, cursor paging, reset).
  - **PHASE 1+2 NOW FUNCTIONALLY COMPLETE on desktop** (mobile init + smoke
    test + signing pending).
  - **Iteration 20 — PHASE 3 STARTS: relay device auth (DONE; server 309
    green incl. 8 new, tsc clean):** `server/src/relayAuth.ts` — per-boot
    HMAC device tokens (`v1.{deviceId}.{exp}.{mac}`, 15-min TTL, stateless;
    restart = silent re-auth; revocation = refuse next challenge, D4),
    ed25519 raw-key SPKI wrap + signature verify, fingerprint =
    b64url(sha256(pubkey)) (doubles as device id), relay identity keygen.
    DB: `relay_devices` / `relay_challenges` (single-use, self-pruning) /
    `relay_identity` (pinned keypair minted first boot) + accessors.
    `routes/relay.ts`: GET /api/relay/info (public, stable fp); device
    enroll/list/revoke on the **legacy session** (= the migration bootstrap
    enrollment path; QR pairing is the later second path); POST
    /auth/challenge + /auth/token — signature payload `{nonce}|{relayFp}`
    (D4b no-cross-relay-replay), **nonce burns even on bad signature**.
    Tests: fp stability, idempotent enroll, cross-account 409, bad key 400,
    happy token path, burn+replay, unknown/revoked 401, token expiry/tamper.
  - **Iteration 21 — relay auth client half (DONE; cargo 23/23, web 434
    green):** vault gains `device_signing_key()` — Ed25519 seed in OS
    keychain, created on first use, **usable while vault locked** (D4: relay
    session survives lock). `relay_client.rs` — connect = GET info (pin fp)
    → challenge → sign `{nonce}|{fp}` → token; `bearer()` silently
    re-fetches inside a 60s expiry margin (D4 layer B); reqwest
    (rustls)+base64 deps; tests: sig binds relay fp (cross-relay replay
    fails), refresh margin, stable pubkey. IPC `device_public_key` /
    `relay_connect` / `relay_status`; managed `RelayClient`. Webview:
    `api.relayEnrollDevice`; `enrollThisDevice()` in migrate.ts —
    **MigrationPrompt enrolls the device key + opens the token session right
    after a successful migration** (best-effort + idempotent).
  - **Iteration 22 — sealed-sender mailbox, server (DONE; server 314 green
    incl. 5 new, build clean):** tables `relay_verifiers` (user →
    b64url(sha256(deliveryToken))) + `relay_mailbox` (per-DEVICE queues).
    Routes: PUT /api/relay/verifier (device-token authed); POST
    /mailbox/send — **no device token by design** (delivery token = the only
    credential; relay never links envelope→sender), **uniform 401** for bad
    handle/verifier/token (no handle enumeration), 256KB envelope cap (blobs
    get their own store), **monotonic relayTs stamp** (D11), fan-out to all
    active devices, opportunistic 30d TTL sweep; GET /mailbox (limit 200) +
    POST /mailbox/ack (deletes own rows only — hold-until-ack per device).
    Tests: fan-out to 2 devices, per-device ack isolation, cross-device ack
    no-op, uniform refusal, strictly-increasing ts, oversize 413.
  - **Iteration 23 — escrow, both halves (DONE; server 317 green incl. 3
    new, cargo 24/24):** server `relay_escrow` table + PUT /api/relay/escrow
    (device-token authed, 8KB cap, opaque payload) + POST /escrow/fetch —
    auth-key proof (server stores b64url(sha256(authKey raw)); presents b64
    key), **route-level rate limit 5/min** (brute-force target), uniform 401
    (wrong key / wrong kind / unknown handle identical). Rust: **auth keys =
    HKDF under `accord/auth/{password,recovery}/v1`** (domain-separated from
    wrap keys — fetch secret can never unwrap what it fetches); vault meta
    gains `escrow{pw,rc auth hashes}` at create; `escrow_bundle()` = payload
    JSON (wrapped pw/rc blobs + public KDF params; **vault-key wrap
    deliberately excluded** — never leaves the device) + hashes;
    `relay_escrow_upload` IPC → RelayClient PUT with bearer. Migration flow:
    enroll → escrow upload (best-effort chain). Cold-start FETCH+restore
    path (fresh device: fetch → unwrap w/ password → rebuild vault) still
    TODO.
  - **Iteration 24 — directory + KT roots (DONE; server 319 green incl. 2
    new files, cargo 24/24):** `relay_directory` (user → identity+sealing
    pubkeys) + `relay_kt_roots` (hash-chained signed epochs). PUT
    /api/relay/directory (device-token authed) → **publishes a new signed
    epoch only when the directory digest changed**; GET /directory/:handle;
    GET /api/relay/kt/roots?since= + **/.well-known/accord/kt-roots**
    auditor alias; /info now exposes the full relay pubkey so anyone can
    verify root signatures (test does: chain links + ed25519 verify).
    **Honest interim shape:** signed chained roots over a whole-directory
    digest — append-only + consistency-checkable, but per-entry inclusion
    proofs + VRF-blinded labels (full AKD lineage) still TODO before the KT
    spec is declared final (noted in code + key-transparency.md governs).
    Rust: `relay_directory_publish` — derives the per-relay identity
    (identity.rs, MK + pinned relay fp) and publishes. Migration chain now:
    **enroll → directory publish → escrow upload**. Gotcha: db-accessor
    field casing leaked into the API response (identityPubkey vs
    identityPubKey) — caught by test.
  - **Iteration 25 — client mailbox loop (DONE; cargo 25/25, tc clean; the
    d61411d commit also landed once 1Password unblocked):**
    `keys::INFO_DELIVERY` + `vault.delivery_token()` — token =
    b64(HKDF(profile.key, "accord/delivery/v1")), verifier =
    b64url(sha256(utf8(token))) **matching the server's hashing convention
    exactly** (test pins it); requires unlock; errors when locked.
    RelayClient: `register_verifier` (bearer), `mailbox_send` (**no bearer —
    sealed**), `mailbox_fetch` (decodes envelopes), `mailbox_ack`. IPC:
    `relay_register_verifier` (returns the token for sealing to friends),
    `relay_send`, `relay_mailbox_fetch`, `relay_mailbox_ack` + native.ts
    wrappers. Migration chain now: **enroll → directory → verifier →
    escrow**.
  - **Iteration 26 — envelope v1 (DONE; cargo 28/28, tc clean):**
    `envelope.rs` — outer `{v:1, eph, nonce, ct}` sealed box (ephemeral
    X25519 ECDH → HKDF-SHA256 salted w/ eph pub → AES-256-GCM); inner
    `{kind, payload, senderIdentityPub, sig, sentAt}` — **sender cert inside
    ciphertext** (D6) and **sig over domain|kind|payload** (D11 backfill
    integrity). `UnknownVersion(v)` error = buffer-and-retry, never drop
    (relay.md policy). Tests: roundtrip + sender pub match; wrong recipient
    → Decrypt; tampered ct → Decrypt; v=2 → UnknownVersion. IPC
    `envelope_seal/open` (derive own identity from MK + pinned relay fp) +
    native.ts wrappers. NOTE: true two-account E2E over a running relay =
    integration-sim layer (testing.md G/I), not yet scripted — crypto +
    transport are each covered separately so far.
  - **Next iterations (phase 3):** escrow cold-start restore (fetch →
    unwrap w/ password → rebuild vault on a fresh device); WS live delivery
    for device queues; security.md relay-state inventory fold-in; phase-3
    review vs relay.md (what's built vs spec: blob store, group state,
    invites, push registration still unbuilt). Desk queue unchanged.

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
