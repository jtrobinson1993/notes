# Roadmap

**This file lists only what is *not built yet*.** Anything shipped is described
in its area spec — see the [spec index](README.md). When something here ships,
delete it from this file and write it up there instead.

Convention: self-contained future work (device pairing, backup export, the web
client, public chats) carries its full design here. Unbuilt *sub-features* of a
shipped surface (invite carriers, rich-notification previews, SAS) are listed
here as items but keep their design beside the surface they belong to, so each
area spec stays readable on its own.

## Where v8 stands

The local-first rework is built: the Tauri shell and Rust core with a SQLCipher
store ([native-app.md](native-app.md), [local-store.md](local-store.md)), the
zero-at-rest relay ([relay.md](relay.md)), the key hierarchy and escrow
([accounts-and-crypto.md](accounts-and-crypto.md)), full-AKD key transparency
([key-transparency.md](key-transparency.md)), DM + group messaging with
attachments ([chat.md](chat.md)), and voice ([voice.md](voice.md)).

What follows is the remainder.

---

## Before launch

### Real-device voice validation

Voice is functionally complete and green in unit + server e2e, but has **never
run on two real devices with real microphones**. That is the true validation for
media, and it comes before any further voice work — including the deferred
in-browser media e2e, which is heavy and timing-sensitive and shouldn't be built
until the happy path is confirmed real.

### Integrated shakedown

Run the whole stack together on a real deployment — relay + `akd-sidecar` +
native app — exercising messaging, attachments, voice and KT before the merge.
Nothing has yet run as a deployed system rather than a test suite.

### The launch cutover

**v8 ships greenfield: no account migration.** The original plan was a per-user
data migration with an identity attestation; with a handful of users that
machinery isn't worth it. Everyone creates a fresh v8 account and re-adds
friends.

1. **⚠ Pre-launch — tell everyone to save their notes.** The cutover **wipes
   everything**: fresh accounts, nothing carried over. Chat history is
   disposable; **notes are not preserved**. This warning is the one irreversible
   step in the plan.
2. **Deploy** the v8 relay + `akd-sidecar` (set `AKD_SIDECAR_TOKEN` for full AKD;
   leave it empty for the interim Merkle path).
3. **Ship the native app** and have everyone install it.
4. **Everyone signs up fresh** and re-adds each other via the invite flow.

Merging the branch *is* the cutover. Dropped along with migration: the
old-key-signs-new-key attestation, the data pull, the T+60 purge, straggler
exports, and the rollback-to-legacy posture.

---

## v8 gaps in shipped surfaces

### Attachments — transfer hardening

Built: per-file keys, encrypt/upload, download/decrypt, and local persistence so
media survives the relay's blob TTL ([local-store.md](local-store.md)). Missing:

- **Chunked + resumable** up/downloads, and integrity verification via the
  content hash. Today a transfer is one shot.
- **Inline encrypted thumbnails** (a few KB in the message) for instant image and
  video preview, with the full blob fetched on demand.
- **Compression on send.** Images already run the WebP pipeline; **video
  transcode → 720p30** (capped bitrate, client-side, before encryption) is not
  built. Both should be default-on with a per-file "send at original quality"
  opt-out.
- **Tunables to enforce:** 100 MB/file cap (relay-configurable), 14-day
  undelivered blob TTL → "attachment expired, re-request from sender".

**Media-codec licensing is decided: LGPL ffmpeg, no GPL components.** The key
insight is that ffmpeg's *hardware-encoder wrappers* are LGPL (encoding happens
in OS/silicon), so one LGPL build covers all five platforms —
`h264_videotoolbox` (macOS/iOS), `h264_mf` (Windows), `h264_mediacodec`
(Android), `h264_vaapi` + an **openh264** fallback (BSD wrapper; Cisco's
prebuilt binary carries their patent grant) on Linux. Output stays H.264+AAC MP4
720p30 for universal webview playback. LGPL obligations: dynamic link, notices,
and an ffmpeg source pointer; the app's own license is unaffected. Bundling
libx264 into an App Store build would have been a real license conflict, which
is why GPL is ruled out.

### Local retention & the Storage screen

The eviction *mechanics* exist (`attachment_evict`, `eviction_watermarks`); the
policy engine and its UI do not. Specified:

- A **Storage screen** showing space used per conversation (media vs messages).
- An **opt-in retention policy, off by default** — never silently delete user
  data — with three modes: **(a)** downscale old media (> X days → ~360p /
  reduced dimensions, still viewable); **(b)** evict old media, keep messages
  (text stays, media shows a re-download placeholder); **(c)** evict everything
  older than X days.
- Manual "clear this conversation's media" / "clear all".
- **Rehydration** of evicted media on demand — from another of your devices
  first, then the sender within relay TTL; gone everywhere ⇒ "expired".

### Push registration (D7)

The relay sends content-free wakes and the service worker drains on them, but
**nothing registers a subscription** — see
[notifications.md](notifications.md#v8--content-free-relay-push). Which client
holds the device token to call `POST /push/subscribe` is entangled with the
client model, so registration lands with the **mobile shell**. Rich
notifications and the preview key (designed in that spec) follow it.

### SAS fingerprint verification (D5)

The server-trust-free anchor for key verification — an out-of-band human compare
of a short authentication string — is **specified but not built**. It matters
most exactly now, while the relay is young and the gossip/auditor ecosystem the
KT log leans on doesn't exist yet. Needs: a Verify screen showing the SAS words,
a "verified" badge on confirmed contacts, and the **soft** key-change tier (a
contact's key changed with valid proofs → non-blocking notice + "unverified
again" badge). The **hard** tier is built.

### Revocation & blocking fan-out

The key hierarchy defines these; none of the rotation machinery is wired:

- **Unfriend (= block)** should rotate the profile key and re-issue delivery
  tokens to all remaining friends. Today `friend_remove` is local.
- **In-group block** — client-side hiding of a non-friend's messages in a shared
  group.
- **Device revocation, both tiers** — the tier-1 rotation fan-out (profile key,
  every conversation/group epoch key, every shared-note key, preview key) and a
  Devices screen to trigger it. Tier 2 (identity compromise) is a documented
  recovery procedure, not a feature, and must never be presented as covered by
  tier 1. See
  [accounts-and-crypto.md](accounts-and-crypto.md#device-revocation--two-named-tiers).

### Groups — membership lifecycle

Create and add-member are built. Missing: **member removal with group-key
rotation**, role changes after creation (grant/revoke admin), and leaving a
group. Removal is the one that matters cryptographically — without it, a removed
member keeps a working group key.

### Notes under v8

Native notes are local-only today: stored as Yjs docs in the local store,
searchable, never synced. Missing, in dependency order:

- **Relay sync of note updates** — encrypted Yjs binary updates relayed as opaque
  blobs under the per-note key (the `note_key` column already exists for this).
- **Note sharing** — the v5 sealed-box share, re-expressed over the relay.
- **Live collaborative editing** with remote cursors/selections, via
  `y-codemirror.next`.
- **Version history over Yjs** — coalesced auto-snapshots (~10 min, mirroring
  today's cadence) plus user-created named versions kept indefinitely, with a
  generous retention cap and update-log compaction beyond the window.
  **Sync scope: fully synced, including co-editors** — a shared note carries a
  shared revision timeline. **Consent requirement: the share flow must tell the
  user that sharing a note also shares its full version history**, so a private
  edit timeline is never disclosed unknowingly.
- An **offline indicator** making "you're offline, changes will sync" legible.

### Device pairing & history transfer (D8)

The only way onto a new device today is escrow recovery, which restores
**identity but no history**. Pairing is the intended primary path:

1. **Pair via QR.** The new device generates an ephemeral X25519 keypair and
   shows its *public* key as a QR; the primary scans it, both show a **SAS** to
   confirm no MITM, and the primary seals MK to the new device.
2. **Bulk history transfer.** While both are online, the primary streams its
   encrypted local store (or a CRDT snapshot) to the new device **through the
   relay as opaque blobs** — nothing durable lands on the server.
3. **Ongoing sync.** Every device is a full replica; the relay queues encrypted
   updates for offline devices.

**Core invariant — MK only ever crosses the wire *sealed to a key held by the
receiving device*.** The real risk is authenticating the *target* device, not the
transport: an attacker who substitutes their own public key would receive MK. So
the channel must be human-verified (in-person QR scan and/or SAS compare), the
blob single-use with a short TTL and deleted on pickup, and linking must raise a
"new device linked" notice with the device listed for revocation. Skipping either
invariant — a plaintext relay, or an unauthenticated channel — **is** a
compromise and is out of scope.

Also unbuilt: the **soft ≥2-device nudge** during onboarding, so single-device
loss isn't catastrophic.

### Offline encrypted backup export (D8)

Because there is no server backup, losing every device loses history — a
deliberate regression from v2's encrypted *server* backups, traded for the
zero-at-rest posture. The mitigation is a **user-initiated, user-stored**
encrypted export, never server-side. Single file, `*.accordbackup`:

```
header (plaintext):  magic ∥ formatVersion ∥ kdf=argon2id{m,t,p,salt} ∥ cipher=XChaCha20-Poly1305
body   (encrypted):  zstd(tar{ db-snapshot.sqlite, blobs/<attachment files>, manifest.json })
```

- Key = Argon2id(**recovery code** by default, or a chosen passphrase — stated in
  the manifest).
- **"Include media"** is an export-time toggle; without it, restored attachments
  enter state `evicted` (re-hydratable).
- Restore = decrypt → verify `formatVersion` → import as a **point-in-time
  snapshot**, then delta-sync from other devices if any exist.
- The manifest records app version, schema `user_version`, account identity
  fingerprint and export time; restore refuses a schema *newer* than the app.

### Multi-relay & cross-relay contact continuity (D4c)

The client talks to **one relay**. The design is a unified aggregate across
several (see [ui.md](ui.md#v8-ui-model-decisions)), plus **persistent multipath
redundancy**: a user may permanently link their identities on two relays for a
given contact via an **E2E, relay-invisible "same-me" attestation**, signed by an
already-verified relay identity so the friend's client auto-trusts the added key
without a fresh out-of-band SAS.

The link is **additive, not a migration** — a contact becomes reachable via
{relay A, relay B, …}, and if A is offline new messages route via B, appended to
the **single local conversation thread**. History is local, so a relay dying
never loses history; this only restores the live channel.

**It preserves per-relay unlinkability:** the attestation is exchanged
friend-to-friend and **never posted to a relay**, so relays still cannot
correlate you across servers — only your friend's client knows. It requires the
relay-independent message id (already built) for cross-path dedup. The same
signed-pointer principle covers a relay **changing its URL** (the relay signs a
"moved to <newURL>" record against its pinned key).

Federation stays out: no relay-to-relay, and cross-relay groups remain a
non-goal. This is 1:1 only.

**Voice fan-out is deliberately deferred within this:** offering a call to every
linked relay simultaneously is a recognizable call-setup signature and gives
colluding relays a timing linkage, so it needs independent per-relay sealing
(call id inside the ciphertext) plus sized/jittered delivery.

### UI surfaces not built

- **The full contact page** — identity (display name, per-relay handles),
  verification (SAS, key-change notices), reachability (relays + failover),
  shared notes and mutual groups, per-conversation notification override, and
  Block. `ProfileDialog` stays the quick peek.
- **Settings sections:** Relays, Devices, Verification, Notifications, Storage,
  Backup. Only device lock, change handle and account switching exist.
- **A connection/sync status affordance** — online/offline, which relays are
  connected, and sync state (syncing / up-to-date / queued-while-offline).
- **Contextual invite UI** — QR and link carriers, and the inline "Join [relay]
  to connect with [name]?" flow. See
  [chat.md](chat.md#invite-carriers-design).
- **Relay nicknames** — a relay self-declares a name; joining should offer a
  local nickname ("Bob's server").
- **A default relay** is deliberately deferred. Until one exists, a new user
  joins a relay during onboarding to mint a handle; first-party default relay(s)
  may be added later to smooth that cold start.

---

## Distribution & platforms

### Mobile shell (iOS + Android)

**Not built.** Launch is desktop-first. The Tauri mobile targets, APNs/FCM push,
and biometric ACLs (Secure Enclave / StrongBox access control gating the
keychain entry) all land together here. OS device-lock detection for the
idle-relock policy (macOS lock notifications, mobile lifecycle) belongs here too.

### Signing & reproducible builds

**Decided: unsigned-first, phased.** For initial small-group testing, ship
unsigned and accept the friction; buy signing identities only when going wider.
The per-platform detail is in
[native-app.md](native-app.md#distribution--signing--phased-unsigned-first-decided).
Outstanding:

- **Reproducible builds** + a "verify this build" affordance in About, so anyone
  can check the shipped binary matches public source. This is the other half of
  the trust story and is unbuilt.
- **Desktop signing** (phase 2) and **iOS** (phase 3, requires the Apple
  Developer Program).
- **Distribution channels** — store vs direct download, and the Tauri updater per
  OS. Deliberately deferred until after implementation. ⚠ The **updater signing
  key is security-critical**: compromising it recreates the served-code problem
  the native app exists to escape.

### Auditor documentation

Add a **"Verifying this relay's key transparency"** section to the root
`README.md`: how to fetch the roots endpoint and run the reference auditor, and
the recommendation to rely on **independent** auditors — an operator auditing its
own log proves nothing. Include pointers for third parties who want to run one.

---

## Post-launch cleanup

A dedicated sweep once v8 ships, to remove what the greenfield transition left
behind:

- The store-level legacy-import methods (`import_notes`, `import_note_versions`,
  `import_conversations`, `import_contacts`) — test-only since the migration
  commands were removed.
- The legacy auth/notes/chat/friends stack and the vestigial session-gated
  `/api/relay/devices` endpoints, once nothing depends on them. The legacy
  passkey web client still builds and its tests still pass, but it is **not** the
  go-forward web surface; removing it is irreversible, so it waits until the
  native launch is settled.
- Dead types and any stale spec sections.

Multi-device enroll returns as device-token-authed pairing (D8) rather than the
legacy device-enroll path.

---

## D16 — a v8 web client (deferred)

A browser client talking to the standalone relay the way the native app does,
replacing the retired legacy web app. **Deferred deliberately — not a toggle.**
The launch is native-only.

**The UI is already shared; the *engine* isn't.** `web/src/` already runs in both
the Tauri shell and a browser and branches on `isNative`, but in native mode it
delegates all keys, crypto, relay and storage to the **Rust core** over
`invoke()`. A browser has none of that. The work is providing the engine, not
rebuilding the UI.

Open decisions to settle before building:

- **Engine strategy.** *(A)* Compile the Rust core to **WASM** plus browser shims
  (keychain → WebCrypto/IndexedDB, SQLCipher → wa-sqlite, reqwest → fetch/WS) —
  reuses the audited protocol with no drift, but large upfront shimming.
  *(B)* Reimplement in TypeScript (`@noble/curves` + WebCrypto + IndexedDB) —
  faster to start, but duplicates the whole relay protocol in a second language,
  meaning drift and a double audit.
- **Security posture (the hard one).** Native's core property is that keys live
  in Rust and **never enter the webview**. A browser client cannot preserve that
  — keys end up in the JS-reachable context (WASM linear memory is readable from
  JS too), so an **XSS becomes key theft**. The web client is therefore
  inherently a **lower-trust satellite**. Decide how far to limit the surface to
  bound the blast radius: read-mostly, no note-key custody, no long-lived DM
  keys, ephemeral session, opt-in.
- **At-rest storage in the browser.** SQLCipher isn't available; choose
  wa-sqlite-with-encryption vs sql.js/IndexedDB under an app-wrapped key, and
  accept that browser at-rest protection is weaker than the native vault.
- **Device identity + pairing.** How a browser enrols as a relay device (its own
  register, or pairing from an existing device), key storage (WebCrypto
  **non-extractable** keys where possible), and the multi-device implications.
- **A WASM `akd_core` verifier** so the satellite can verify key transparency —
  plus a JS reimplementation of self-audit and gossip.

**Decided shape if it happens:** satellite-only (QR-linked from a native device,
never a standalone login, never holds durable identity), **in-memory only**
(nothing survives tab close), able to do live chat, recent history on demand,
online note view/edit and voice — but **not** full offline history, full replica
status, or backup export/restore. **Recent history is served by a linked native
device over the relay** (the WhatsApp-Web model), since the relay stores nothing.
Session-scoped by default with an opt-in "keep me linked", and **always remotely
unlinkable** from the native device's device list.

---

## v9 — Public chats (post-v8)

The pseudo-Discord "public room" story. Direction decided during the v8 design
pass; nothing here is in v8's scope.

### Decided direction

- **A new, distinct chat type — and it is NOT E2E-encrypted.** E2EE in a room
  anyone with a link can join protects against nobody (any party, including the
  operator, can join pseudonymously and read) while costing O(members) rekey
  churn on every join/leave. Making public chats **plaintext-to-relay**
  eliminates that churn, lets the **relay store and serve public history** (which
  removes the member-served-backfill availability and tamper problem for this
  chat type entirely), enables **server-enforced admin controls**, and scales to
  large rooms. This is a deliberate, explicitly-public carve-out from
  zero-at-rest — that posture exists to avoid holding *private* content.
- **Link-joinable, not directory-listed.** A standing, multi-use group invite
  link that grants room membership, not friendship.
- **Admission is manual** — a joiner waits until the owner or an admin admits
  them, with an optional "admit all" for large influxes.
- **Sender signatures are still required** even in plaintext rooms, so neither
  the relay nor a member can forge or alter what someone else said.

### Open questions

- **Moderation & operator exposure.** A relay hosting plaintext public content
  takes on real moderation duties — abuse/CSAM/DMCA exposure the zero-at-rest
  design deliberately avoided. Likely **opt-in per relay**, and it needs its own
  [security.md](security.md) section.
- **Retention** — does public history live on the relay forever? Caps, pruning,
  owner-configurable retention?
- **Scale ceilings** — read receipts and typing must be suppressed or batched in
  large rooms (N members ⇒ ~N² receipt events per fully-read message); media
  multiplies home-upload bandwidth (N × blob fetches per attachment).
  Thumbnail-first and lazy fetch help, but caps may be needed.
- **Admin powers** — with plaintext rooms, deletion/pinning/slow-mode become
  server-enforceable. How much of that surface to build?
- **Identity exposure** — joining exposes your per-relay handle to strangers.
  Read-only lurking? A per-room display identity?
- **Friends-gate interaction** — confirm that public-room co-membership implies
  **no** DM or share reach, unlike friends-of-friends group co-membership.
- **Discovery** — any directory at all, or links only?

---

## v12 — Video streaming in voice channels?

Far future — not intended for a long time.

- What strain would this put on server-host hardware?

---

## Smaller deferred items

- **Opus DTX (silence suppression)** — off deliberately; revisit only if
  bandwidth becomes a problem. Note the trade: continuous transmission keeps the
  rate flat, so speech-activity timing isn't exposed; adding DTX reintroduces
  that leak. See [voice.md](voice.md).
- **In-browser voice media e2e** — a bundled same-origin harness page loading
  `voiceMedia` with a REST `SfuControl`, two fake-mic peers producing and
  consuming, asserting media actually flows. Heavy and timing-sensitive; gated
  behind real-device validation.
- **Biometric ACL gating** on the keychain entry (Secure Enclave / StrongBox
  access control) — currently the keychain entry is not additionally
  biometric-gated. Lands with the mobile shell.

## Non-goals

- **Pure peer-to-peer / DHT.** Availability (offline delivery), groups, and NAT
  traversal all need a relay; a thin relay is kept deliberately.
- **Federation** — no relay-to-relay protocol; cross-relay groups stay out.
- **A user-chosen username.** The handle is the only identifier.
- **IP-correlation mitigation** (Tor/mixnet integration) — out of scope; see
  [security.md](security.md#v8-trust-boundaries-worth-stating-plainly).
- **Third-party transparency auditors as a service we run** — v8 *enables*
  independent auditors (public roots endpoint, published log format, open-source
  reference auditor) but does not operate them. An operator-run auditor carries
  no trust value.
- **An opt-in global same-handle directory** — considered, not planned.
