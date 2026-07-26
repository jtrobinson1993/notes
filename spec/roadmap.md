# Roadmap

**This file lists only what is *not built yet*.** Anything shipped is described
in its area spec — see the [spec index](README.md). When something here ships,
delete it from this file and write it up there instead.

Convention: self-contained future work (device pairing, backup export, a web
client, public chats) carries its full design here. Unbuilt *sub-features* of a
shipped surface (invite carriers, rich-notification previews, SAS) are listed
here as items but keep their design beside the surface they belong to, so each
area spec stays readable on its own.

## Where v8 stands

**The product is now a native app and a relay, and nothing else.** The browser
client is deleted, not deprecated: the passkey SPA, the all-in-one Fastify
server, the service worker/PWA, the IndexedDB note cache, the session/CSRF
layer, the admin UI and the `E2E_TEST_AUTH` test-session seam are gone from the
tree. Removing them was on this roadmap; it is done.

Built: the Tauri shell and Rust core over a SQLCipher store
([native-app.md](native-app.md), [local-store.md](local-store.md)), the
zero-at-rest relay including its privacy content proxies ([relay.md](relay.md)),
the key hierarchy and escrow plumbing
([accounts-and-crypto.md](accounts-and-crypto.md)), full-AKD key transparency
([key-transparency.md](key-transparency.md)), DM + group messaging with
attachments ([chat.md](chat.md)), 1:1 voice that fails closed without frame
E2EE ([voice.md](voice.md)), and the toast surface + error catalogue
([notifications.md](notifications.md)).

Not yet real: the app has **never run as a deployed system** — no real-device
voice, no shakedown, no signed build. Several relay-side features have **no
client half** (content proxies, push). And the documentation pass that produced
this roadmap turned up a set of verified defects, listed below, that must be
fixed before launch.

---

## Before launch

### Real-device voice validation

Voice is functionally complete and green in unit + relay e2e, but has **never
run on two real devices with real microphones**. That is the true validation for
media, and it comes before any further voice work — including the deferred
in-browser media e2e, which is heavy and timing-sensitive and shouldn't be built
until the happy path is confirmed real.

It also has to establish something the code currently assumes: **which shipping
webviews actually expose `RTCRtpScriptTransform`**. Voice now fails closed
without it ([voice.md](voice.md#fail-closed-no-call-without-frame-e2ee)), so a
webview that lacks it cannot place or accept a call at all. WebKitGTK, WebView2
and WKWebView need to be checked on real machines, and the result recorded in
voice.md.

### Integrated shakedown

Run the whole stack together on a real deployment — relay + `akd-sidecar` +
native app — exercising messaging, attachments, voice and KT before the merge.
Nothing has yet run as a deployed system rather than a test suite.

### Defects to fix before launch

These are **verified bugs**, not missing features — each was confirmed against
the code during the v8 documentation pass and is recorded as a known gap in the
relevant area spec. They are listed here because fixing them is outstanding work.

**Data loss / user-visible breakage**

- **Chat attachments never render.** `NativeChat.vue` sends
  `JSON.stringify(refs)` — a bare array — into `attachments_json`, while
  `nativeChat.ts::rowToView` parses `{attachments, system}`. Neither the sender
  nor the recipient ever sees an attachment. The tests miss it because
  `NativeChat.test.ts` mocks at the `ChatMessageView` level and
  `nativeChat.test.ts` feeds the wrapper shape. Fix one side, and add a test that
  crosses the send→ingest→render boundary with the real shape.
- **Note attachments are lost on reload.** `NotePayload.attachments`
  (`web/src/lib/nativeNotes.ts`) is never persisted or rehydrated, so the
  per-file key/IV dies with the session, the `attachment:` markup dangles, and
  the ciphertext is orphaned in the blob store with no eviction path. See
  [notes.md](notes.md#attachments).
- **Bio and avatar are silently discarded.** `useProfileStore().save()` writes
  only `profile.displayName`; the editor says "Profile saved." for data that is
  dropped on lock or restart, and nothing renders it anyway. Either persist them
  (see *Profiles* below) or stop offering the fields.
- **Paging can drop or duplicate a message.** `store.rs` filters the backfill
  cursor on `(relay_ts, id)` but orders by
  `relay_ts DESC, sender_contact_id DESC, id DESC`. Same-millisecond ties can
  fall across a page boundary. Make the cursor the full sort key.
- **`friend-confirm` is best-effort and never retried.** The accept is acked
  regardless of whether the confirm send succeeds, so one failed send leaves a
  permanent half-friendship — one side has the other's delivery token, the other
  does not. Needs a retry queue or a re-confirm on next connect.
- **`NativeCallPanel` never leaves "Connecting…".** `VoiceCall.onMediaConnected()`
  is called only from tests, so the panel shows connecting even with audio
  flowing. Wire it from the media layer.

**Security-relevant (see also *Security work outstanding*)**

- **`POST /api/relay/push/subscribe` stores an unvalidated endpoint.** The route
  checks presence only; the deleted `server/src/routes/push.ts` enforced
  `startsWith('https://')` plus 2048/256-char caps. `web-push` will then POST to
  whatever was stored whenever `notifyMailbox` fires — an authenticated SSRF out
  of the relay (`http://169.254.169.254/…`) plus unbounded strings in the DB.
  This is a **regression against the route it replaced**; restore the three
  checks. Unreachable today only because no client subscribes.
- **Escrow restore can silently destroy recovery-code restore.**
  `vault.rs::restore_from_escrow` writes `recovery_auth_hash: String::new()`. If
  that device later uploads escrow, `PUT /api/relay/escrow` stores `""` (the
  `?? null` guard does not catch an empty string), overwriting the real hash. It
  **fails closed** (`!stored` → 401, and no SHA-256 output is empty), so it is
  not exploitable — but it permanently disables recovery-code cold start for
  that account. Carry the real hash through restore, and reject an empty
  `recoveryAuthHash` server-side.
- **Voice frame keys outlive the call.** `dropFrameKey` and `resetVoiceWorker`
  exist and are called from nowhere; `teardownCallHost` hangs up on vault
  re-lock but leaves the last call's key live in the frame worker for the life
  of the process. Call `resetVoiceWorker()` on call end and in
  `teardownCallHost`. No downside, no product decision — just work.

**Correctness, lower stakes**

- **Edit is not a logical-clock LWW.** `message_apply_edit` overwrites without
  comparing `edited_at`. Fine for single-author edits, which is all that exists;
  [local-store.md](local-store.md#crdts--mutable-state) describes the intended
  rule.
- **The KT auditor's stall alarm is a false positive by construction.** It
  alarms after 24 h with no new epoch, but the relay only publishes on a
  directory change. Either add a heartbeat epoch (the relay signs and appends a
  root on a timer even with no change — which is also what makes gossip useful
  on a quiet relay) or drop the stall check.
- **Stale doc comments claiming a first-user bypass.** `server/src/config.ts`
  and the `/api/relay/info` handler both say the first account is always allowed
  and becomes the admin. `POST /api/relay/register` has no such bypass and
  always assigns `role: 'member'`. The code is the stricter one; fix the
  comments before someone "restores" the documented behaviour.

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

## Security work outstanding

Grouped because these are the gaps where a spec once promised a protection the
code does not provide, or where a shipped surface has a known hole. Each is
cross-referenced from the relevant area spec.

### A Content-Security-Policy for the native webview

**The app has no CSP at all.** `src-tauri/tauri.conf.json` sets
`"security": { "csp": null }`, `web/index.html` carries no meta policy, and
nothing injects one at runtime. The relay still emits a CSP, but it is API-only
and serves no HTML, so no browser ever applies it — `inlineScriptHashes` is dead
in production, and `worker-src` / `manifest-src` / the YouTube `frame-src` entry
are SPA-era vestiges.

Today's XSS defence is therefore the token renderer alone: the Markdown
pipeline builds DOM nodes and never parses HTML, so a hostile message has no
script-injection vector by construction
([security.md](security.md#rendering-safety--no-v-html-raw-html-inert)). That is
a strong property, but it is a *single* layer, and nothing in the code or the
history records a decision to run without a CSP — this is unbuilt hardening, not
a considered tradeoff.

It matters more now than it did: the emoji and GIF work below will load remote
images through the relay proxies, adding the first routine remote-content fetch
the webview makes.

The policy has to be written against a *running* app, because the constraints
are all runtime ones:

- bundled assets under Tauri's custom protocol (`tauri://` / `http://tauri.localhost`),
- `blob:` and `data:` for decrypted attachments, avatars and object URLs,
- `connect-src` for the relay origin (HTTPS + WSS) — which is user-configurable,
  so the policy either allows any HTTPS origin or is templated per account,
- mediasoup's WebRTC (not CSP-governed, but the worker/wasm surfaces around it are),
- `wasm-unsafe-eval` if any WASM ends up in the webview,
- `img-src` for relay-proxied emote/GIF images.

Target: `default-src 'none'` with explicit allowances, no `unsafe-inline` for
scripts, and a smoke test that the app still functions with it on. Delete the
dead relay-side directives at the same time.

### Relay identity is never pinned

`invites.ts` documents `relayFp` as "Pinned relay identity fingerprint (the
invitee verifies the relay)" and the field is written into every invite by
`nativeInvites.ts` — but **it is never read back for comparison**.
`RelayClient::connect` takes whatever `/api/relay/info` returns and uses it as
the session fingerprint; there is no stored pin and no TOFU check across
connects.

Consequences: a substituted relay identity is undetectable, and redeeming an
invite against an impostor at the invite's URL is undetectable. Worse, the
per-relay identity is *derived* from that fingerprint
([accounts-and-crypto.md](accounts-and-crypto.md#per-relay-derived-identities-identityrs)),
so a swapped key silently re-derives the user's identity keys — the user appears
as a different person rather than failing.

Needed: store the fingerprint on first connect (per account, in the vault),
compare on every subsequent connect, and compare the invite's `relayFp` against
`/api/relay/info` before redeeming. A mismatch is a hard stop with an error-catalogue
code, not a toast the user can dismiss. The signed "relay moved to <newURL>"
record (see *Multi-relay* below) is the legitimate way to change either.

### No key is ever verified against the transparency log

`src-tauri/src/kt.rs::verify_lookup` is implemented and unit-tested but **called
from nowhere**. Only `verify_key_history` (self-audit) and `verify_signed_root`
(gossip) are wired. Contact keys come exclusively from the invite payload as a
TOFU pin — there is no directory-lookup path in the client at all.

So KT currently proves *the relay is not equivocating about my own key* and
*roots are consistent across gossip peers*; it does not yet prove that the key
you are talking to is the one the log published for that handle. Wiring
`verify_lookup` into contact establishment (and into any future re-key) is what
closes the loop. See [key-transparency.md](key-transparency.md#client-verification-native-as-built).

### The hard KT alarm warns but does not block

`KtAlarm.vue` renders a non-dismissable banner and nothing else: no path in
`NativeChat.vue`, `nativeChat.ts` or the `relay_send*` commands consults the
alarm state. A user who ignores the banner keeps sending to a possibly-equivocated
key. The docs described this as halting sends to affected contacts; it does not.

Decide and then build one of: (a) block sends to the affected contacts while a
hard alarm is active, which is what the docs promised and what the alarm's
severity implies; or (b) accept advisory-only and say so in
[security.md](security.md) as well as [ui.md](ui.md#key-integrity-warnings--two-tiers).
Recommendation is (a) — a hard alarm means the relay may be serving different
keys to different people, and sending anyway is exactly the action that leaks.

The **soft** tier (a contact's key changed with valid proofs → non-blocking
notice + "unverified again" badge) is also unbuilt; see SAS below.

### An inbound `friend-accept` is trusted from any sender

`message::disposition` → `Disposition::Friend` → `store.record_friend(...)` runs
unconditionally for `friend-accept` / `friend-confirm`, and for an *accept* the
drain seals **my handle and my delivery token** back to the sender's supplied
sealing key. Nothing correlates the envelope with an invite I actually minted:
the invite payload carries `identityPub` explicitly as a TOFU pin, but it is
parsed and discarded, never compared against the sender.

Consequences: anyone who can enqueue into my mailbox — an existing friend, a
live-invite holder, or the relay, which owns the queue — can insert themselves
into my friends list under an arbitrary handle *and receive my delivery token*.
An unfriended contact can silently re-friend themselves, because `record_friend`
sets `is_friend = 1` on conflict.

Closing it is a design change, not a patch: the client needs durable local
memory of outstanding invites (today minted invites are held in memory for the
session only), each pinned to the `identityPub` it was minted for, and the drain
must match an inbound accept against a live invite and its pinned key before
recording a friend or replying with a delivery token. Un-matched accepts should
be dropped, not surfaced. This also gives invite revocation something to revoke.
See [chat.md](chat.md#security-properties-and-the-gaps).

### Revocation & blocking fan-out

The key hierarchy defines these; none of the rotation machinery is wired:

- **Unfriend (= block)** should rotate the profile key and re-issue delivery
  tokens to all remaining friends. Today `friend_remove` does the local half
  only — an unfriended contact keeps a **working** delivery token and can still
  queue envelopes into your mailbox. Nothing in the product currently revokes
  reach.
- The profile key **cannot rotate as designed**. It is
  `HKDF(MK, "accord/profile-key/v1")`, cached in the `profile.key` setting,
  deliberately so that every device derives the same delivery token without D8
  pairing. Rotation therefore needs either pairing first, or an explicit
  rotation counter mixed into the derivation and distributed to friends — decide
  which before building the fan-out. See
  [accounts-and-crypto.md](accounts-and-crypto.md#why-the-profile-key-is-derived-not-random).
- **In-group block** — client-side hiding of a non-friend's messages in a shared
  group.
- **Device revocation, both tiers** — the tier-1 rotation fan-out (profile key,
  every conversation/group epoch key, every shared-note key, preview key) and a
  Devices screen to trigger it. Tier 2 (identity compromise) is a documented
  recovery procedure, not a feature, and must never be presented as covered by
  tier 1. See [accounts-and-crypto.md](accounts-and-crypto.md#revocation).

Relay-side revocation of a *device token* is already immediate — the auth
middleware re-checks the `revoked` column on every request — so this work is
entirely about the key fan-out, not about the relay.

### SAS fingerprint verification (D5)

The server-trust-free anchor for key verification — an out-of-band human compare
of a short authentication string — is **specified but not built**. It matters
most exactly now, while the relay is young and the gossip/auditor ecosystem the
KT log leans on doesn't exist yet. Needs: a Verify screen showing the SAS words,
a "verified" badge on confirmed contacts, and the **soft** key-change tier.

---

## v8 gaps in shipped surfaces

### Emoji, GIFs and link previews — the client half

The relay side is built and documented in
[relay.md](relay.md#content-proxies-privacy-not-features): device-token-authed
`/api/relay/gifs/{search,trending}`, `/api/relay/og`,
`/api/relay/emotes/search`, and a capability-gated `/api/relay/emote/:sig/:file`
image endpoint. **No client calls any of them.**
`web/src/lib/emoji/index.ts` never populates the emote registry, so
`resolveEmoji` resolves nothing and `EmojiText`/`EmojiInput` only ever surface
unicode emoji. The 7TV manifest that used to be bundled is gone and nothing
replaced it in the UI.

Outstanding, in dependency order:

1. **Wire emote search into the picker.** Query
   `/api/relay/emotes/search` through the Rust core (so the device token never
   crosses IPC, as with the SFU calls), register the returned names/URLs with
   `registerEmote`, and rank results with the existing decayed usage store
   (`web/src/lib/emoji/usage.ts`, already built and persisted in the vault).
2. **The on-device used-emoji store.** Search is live and network-bound; the
   emoji you have *already seen* must render offline and without a round-trip.
   Agreed design:
   - A SQLCipher-backed store in the Rust core holding the bytes of every emoji
     actually **encountered in a message or note** — not search results, which
     are browsing, not content.
   - **Size-bounded with LRU eviction**, the same shape as the attachment
     eviction that already exists. A miss re-fetches from the relay proxy; an
     eviction is never user-visible beyond a fetch.
   - **A single shared render component persists what it renders.** Making the
     renderer the only writer means an emoji is cached exactly when it is
     genuinely displayed, and there is one place to enforce the caps. The picker
     and search results must opt out explicitly.
   - **Per-message cap on distinct emote fetches.** This is the security-relevant
     part: without it a hostile sender puts 500 distinct emote refs in one
     message and every recipient's client fetches 500 images — turning each
     recipient into a fetch amplifier against the relay, and filling their disk.
     Cap the distinct emotes rendered-and-cached per message (a small number,
     ~20), render the remainder as literal `:shortcode:` text, and count the cap
     per message rather than per view so re-rendering cannot bypass it.
   - **The picker falls back to the cached set when offline**, so emoji keep
     working with no relay.
3. **GIF search UI**, which must bring back the **recipient-side host
   allowlist**. The old `safeGif` check (render only `*.<provider>` CDN hosts)
   died with the legacy chat store. Klipy returns third-party CDN URLs, so a
   client that renders them leaks exactly the IP the proxy exists to hide —
   either proxy the media too, or make the allowlist a hard precondition of the
   feature. Same constraint applies to the `image` URL in an `/og` response.
   Also: `registerEmote()`'s doc comment says "relay origin only" but does not
   enforce it — enforce it in code as part of this work.
4. **Link previews in chat**, and with them a **local link-preview preference**.
   The old on/off toggle was a server-side per-user profile flag and went with
   the legacy stack; it must come back as a **device-local** setting alongside
   the existing click-to-load image/embed toggles in `web/src/lib/privacy.ts`
   (`localStorage`, no server involvement). Default off — fetching a preview,
   even through the relay, tells the relay which link you were sent.

### Push registration (D7)

The relay sends content-free wakes (`{type:'mail'}`) and exposes
`GET /api/relay/push/key` + `POST /api/relay/push/{subscribe,unsubscribe}`, but
**nothing registers a subscription** and nothing consumes a wake — the service
worker that used to drain on one is deleted. See
[notifications.md](notifications.md#relay-side-push-plumbing-built-unreachable).

Which client holds the device token and how a wake is delivered is entangled
with the client model (a web satellite would use Web Push directly; mobile needs
APNs/FCM, not web push), so registration lands with the **mobile shell**. Rich
notifications and the preview key — designed in that spec, and security-critical
enough that the reasoning must not be re-derived casually — follow it.

Nearer term and independent of push: **desktop OS notifications while the app is
running but unfocused** do not exist either. Only the window title changes.
That needs no relay work at all and should not wait for D7.

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
- **`nameForType` is dead code** — an optimized image keeps `photo.jpeg` while
  carrying WebP bytes. Either call it or delete it.

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

The emoji cache above should share this screen and this eviction machinery
rather than growing its own.

### Groups — membership lifecycle

Create and add-member are built. Missing: **member removal with group-key
rotation**, role changes after creation (grant/revoke admin), and leaving a
group. Removal is the one that matters cryptographically — without it, a removed
member keeps a working group key, so "remove" would be a lie in the UI. Build
the rotation with the removal, not after it.

### Escrow — upload, cold start, and device re-enrolment

The escrow *plumbing* is complete on both sides (relay routes, Rust commands,
tests) and **entirely unreachable**:

- **Nothing ever uploads an escrow blob.** `relayEscrowUpload()` in
  `web/src/lib/native.ts` has zero call sites and `relay_escrow_upload` is never
  invoked from onboarding or Settings. No account has an escrow row, so the
  "Log in" screen in `NativeGate.vue` cannot restore anything. Upload has to
  happen at signup (and after a password change), with the user told plainly
  what is stored and what it protects.
- **Recovery-code cold start is unreachable.** The client only ever sends
  `authKind: 'password'`; `POST /api/relay/escrow/fetch` supports both. Wire the
  recovery-code path, and fix the empty-`recovery_auth_hash` bug above first.
- **A restored device cannot reach the relay.** `vault_restore_from_escrow`
  rebuilds MK and the identity keys, but the device's Ed25519 signing key is
  fresh-random per device, so it is in no `relay_devices` row and
  `POST /api/relay/auth/token` 401s. There is no enrolment endpoint — a device
  enrols only via `POST /api/relay/register`, which creates an account. So
  escrow restore currently yields a working local vault with **no connectivity**.
  Needs a device-enrolment path authorized by something the restored device
  proves it holds (an escrow-derived key, or the account's identity key), which
  is adjacent to but distinct from D8 pairing.

Until all three land, escrow is not a recovery story and should not be described
to a user as one. See
[accounts-and-crypto.md](accounts-and-crypto.md#account-escrow--cold-start).

### Profiles — storage and updates

[profiles.md](profiles.md) covers what exists: the handle, and an E2EE display
name that travels **once**, inside the sealed friend-accept/confirm payload.
Outstanding:

- **Persist bio and avatar** (see the defect above), and decide where they live —
  the profile key exists but currently has exactly one job, deriving the delivery
  token.
- **Distribute profile updates after friending.** Changing your display name
  today updates your own device and nothing else; there is no channel that
  carries a profile change to existing friends. Needs a sealed profile-update
  message to each friend, which is also the natural carrier for bio/avatar.
- **Decorations** (animated avatars, profile backgrounds/borders) — still a
  "maybe", still unimplemented.

### Notes under v8

Native notes are local-only today: stored as Yjs docs in the local store,
searchable, never synced. Missing, in dependency order:

- **The `y-codemirror.next` binding.** It is not even a dependency. What exists
  is a coarse delete+insert into one `Y.Doc` per note, persisted as
  `crdt_docs.ydoc_state`; nothing writes `crdt_updates`. Real CRDT editing
  starts here.
- **Relay sync of note updates** — encrypted Yjs binary updates relayed as opaque
  blobs under the per-note key (the `note_key` column already exists for this).
- **Note sharing** — the v5 sealed-box share, re-expressed over the relay. Until
  it exists, `notes.shared_json` is never written and the read-only / "shared by"
  branches in `NoteEditor.vue` are unreachable.
- **Live collaborative editing** with remote cursors/selections.
- **Version history over Yjs** — coalesced auto-snapshots (~10 min, mirroring
  today's cadence) plus user-created named versions kept indefinitely, with a
  generous retention cap and update-log compaction beyond the window.
  **Sync scope: fully synced, including co-editors** — a shared note carries a
  shared revision timeline. **Consent requirement: the share flow must tell the
  user that sharing a note also shares its full version history**, so a private
  edit timeline is never disclosed unknowingly.
- An **offline indicator** making "you're offline, changes will sync" legible.
- **Expose full-text search.** `notes_search` (FTS) is built in the core and
  unused by the UI.

### Voice — in-call features

The call panel is deliberately minimal (phase, peer, hang up). Not built, and
previously written up as if shipped:

- **Mute, deafen, per-person volume, speaking highlight, connection quality.**
- **Push-to-talk and noise suppression are inert.** The PTT mode/key and the
  RNNoise strength slider persist preferences nothing reads; no RNNoise worklet
  is loaded, and `@sapphi-red/web-noise-suppressor` is an unused dependency.
  Either wire them or remove the settings — offering a control that does nothing
  is worse than not offering it.
- **Group calls / voice channels.** v6's voice channels were keyed to
  server-side channel membership, which a zero-at-rest relay cannot know; a
  group call needs its own capability model (call id sealed to each group
  member) before any UI.
- **Frame-key rotation.** One key at epoch 0 for the life of a call; the wire
  format carries an epoch byte for this and nothing increments it.
- **A narrow-viewport call layout.** `NativeCallPanel` is one fixed bottom-right
  card on every viewport.

### Device pairing & history transfer (D8)

The only way onto a new device today is escrow recovery, which restores
**identity but no history** (and, as above, no relay access). Pairing is the
intended primary path:

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

The client talks to **one relay**, and `relay_invite_redeem` posts to the
*connected* relay — so redeeming an invite minted on another relay does not work
today, even though the invite carries `relayUrl`/`relayFp`. The design is a
unified aggregate across several relays (see [ui.md](ui.md#v8-ui-model-decisions)),
plus **persistent multipath redundancy**: a user may permanently link their
identities on two relays for a given contact via an **E2E, relay-invisible
"same-me" attestation**, signed by an already-verified relay identity so the
friend's client auto-trusts the added key without a fresh out-of-band SAS.

The link is **additive, not a migration** — a contact becomes reachable via
{relay A, relay B, …}, and if A is offline new messages route via B, appended to
the **single local conversation thread**. History is local, so a relay dying
never loses history; this only restores the live channel.

**It preserves per-relay unlinkability:** the attestation is exchanged
friend-to-friend and **never posted to a relay**, so relays still cannot
correlate you across servers — only your friend's client knows. It requires the
relay-independent message id (already built) for cross-path dedup. The same
signed-pointer principle covers a relay **changing its URL** (the relay signs a
"moved to <newURL>" record against its pinned key) — which only becomes
meaningful once the fingerprint is actually pinned (see above).

Federation stays out: no relay-to-relay, and cross-relay groups remain a
non-goal. This is 1:1 only.

**Voice fan-out is deliberately deferred within this:** offering a call to every
linked relay simultaneously is a recognizable call-setup signature and gives
colluding relays a timing linkage, so it needs independent per-relay sealing
(call id inside the ciphertext) plus sized/jittered delivery.

### UI surfaces not built

- **Any per-contact UI at all.** `ProfileDialog` is deleted; friends render as
  name + handle + initial and nothing more. The quick peek has to be rebuilt
  from zero, and then the **full contact page** on top of it — identity (display
  name, per-relay handles), verification (SAS, key-change notices), reachability
  (relays + failover), shared notes and mutual groups, per-conversation
  notification override, and Block.
- **Settings sections:** Relays, Devices, Verification, Notifications, Storage,
  Backup. Only Profile, Appearance, device lock, Privacy, Voice and
  import/export exist, and account switching lives in the rail.
- **A connection/sync status affordance** — online/offline, which relays are
  connected, and sync state (syncing / up-to-date / queued-while-offline). The
  rail has no status line at all today.
- **Contextual invite UI.** Built: the invite string, copy/pasted through any
  channel. Not built: the **carriers**. An invite encodes
  `{relay routing hint + relay key fingerprint + one-time invite token}` so the
  recipient never manually picks a server, and two carriers are specified for the
  same token — **in-app** (shared through an existing chat; the client recognizes
  a known prefix and renders a tappable "add friend" button) and **out-of-app**
  (a QR, or a universal/App Link carrying the token and relay fingerprint in the
  URL **`#fragment`**, which is never sent to any server, falling back to a
  static inert "open in Accord" page when the app isn't installed).
  **Redemption always runs through the app, never a browser session** — so no
  Referer / User-Agent / cookie / fingerprint leak. Plus the inline "Join
  [relay] to connect with [name]?" flow. See
  [chat.md](chat.md#invite-carriers).
- **Relay nicknames** — a relay self-declares a name; joining should offer a
  local nickname ("Bob's server").
- **Rail avatars and custom group icons.** Group icons are the group name's
  initial; there are no member-initial montages and no uploaded icons.
- **A default relay** is deliberately deferred. Until one exists, a new user
  joins a relay during onboarding to mint a handle; first-party default relay(s)
  may be added later to smooth that cold start.

---

## Testing

[testing.md](testing.md) documents the four-layer strategy and what each layer
would cover. **L1 (Rust core unit tests) is built; L2–L4 are not.**

### L2 — two Rust cores against a real relay · not built

Drive two `Store`/`RelayClient` instances in-process against a booted relay and
assert the protocol end to end: invite → friend → send → drain → decrypt →
ingest, group fan-out, attachment upload/download, escrow round-trip. This is
the layer that would have caught the `friend-confirm` half-friendship and the
paging-cursor bug. No webview involved, so it runs anywhere CI runs.

### L3 — Playwright against a faked Tauri IPC · not built

Run the real Vue app in a real browser with a **stateful fake** standing in for
the Rust core, so UI flows (onboarding, unlock, chat, settings) get browser-grade
coverage without a native shell. Checked against the installed
`@tauri-apps/api` (2.11.1), the seam is small but exact:

- `isTauri()` reads `globalThis.isTauri` — a fake that only sets
  `__TAURI_INTERNALS__` leaves `isNative === false` and the UI takes no native
  path at all.
- `invoke()` calls `window.__TAURI_INTERNALS__.invoke(cmd, args, options)`.
- Events go through `invoke('plugin:event|listen', …)` with a handler registered
  via `window.__TAURI_INTERNALS__.transformCallback`, so the fake must implement
  `transformCallback` to *push* frames at the UI rather than only answer calls.

`@tauri-apps/api/mocks` is rejected for this: it mutates `window` in the current
JS context, which under Vitest is Node and under Playwright is the wrong side of
the process boundary.

### L4 — real-shell smoke · not built

One thin pass through the actual Tauri binary, to catch what a fake cannot:
webview quirks, the custom protocol, keychain access, and (post-CSP) that the
policy doesn't break the app.

### The constraint that shapes L3 and L4

`tauri-driver` is **Linux and Windows only** — Apple ships no WKWebView
WebDriver, and macOS is the development machine. So load-bearing UI coverage has
to live in L3, with L4 kept to a smoke run on a platform that supports it.
`@srsholmes/tauri-playwright` (MIT, pre-1.0, ~39 stars) is worth evaluating for
L4; the pre-1.0 dependency risk is real and should be weighed before adopting.

### Re-point the coverage gate

`vitest.config.ts`'s coverage `include` and per-file thresholds still name
deleted modules (`web/src/lib/chatCrypto.ts`, `lib/recovery.ts`,
`stores/chat.ts`, `server/src/routes/chat.ts`, `session.ts`, `realtime.ts`).
Vitest silently skips a per-file threshold when it has no data for that file, so
those bars — including a 100% one — enforce nothing, and `npm run coverage`
currently exits 0 while measuring almost no v8 surface. Point it at the modules
that exist (`web/src/lib/native*.ts`, `chatView.ts`, `invites.ts`, `toast.ts`,
`errors/`, `stores/friends.ts`, `server/src/relayAuth.ts`, `ssrf.ts`,
`linkPreview.ts`, `emotes.ts`, `routes/relay*.ts`) and set thresholds from
measured reality.

---

## Distribution & platforms

### Mobile shell (iOS + Android)

**Not built.** Launch is desktop-first. The Tauri mobile targets, APNs/FCM push,
and biometric ACLs (Secure Enclave / StrongBox access control gating the
keychain entry) all land together here. OS device-lock detection for the
idle-relock policy (macOS lock notifications, mobile lifecycle) belongs here too.

Note that **biometric gating does not exist on desktop either**:
`vault_unlock_keychain` is a plain `keyring` read with no access-control list and
no prompt. Any UI copy promising biometrics is currently wrong (see
`web/src/components/settings/DeviceLockSettings.vue`).

### Signing & reproducible builds

**Decided: unsigned-first, phased.** For initial small-group testing, ship
unsigned and accept the friction; buy signing identities only when going wider.
The per-platform detail is in
[native-app.md](native-app.md#distribution--signing--phased-unsigned-first-decided).
Outstanding:

- **Reproducible builds** + a "verify this build" affordance in About, so anyone
  can check the shipped binary matches public source. With the browser client
  gone, trust has moved from "the host serves the bundle" to **distribution** —
  this is the other half of that story and it is unbuilt.
- **Desktop signing** (phase 2) and **iOS** (phase 3, requires the Apple
  Developer Program).
- **Distribution channels** — store vs direct download, and the Tauri updater per
  OS. Deliberately deferred until after implementation. ⚠ The **updater signing
  key is security-critical**: compromising it recreates the served-code problem
  the native app exists to escape.

---

## Cleanup — what the deletion left behind

The legacy stack is deleted; these are the fragments that survived it. Dead
crypto and dead auth code are an audit hazard, and dead config breaks builds, so
this is not purely cosmetic.

**Relay**

- **Drop the legacy DB schema.** `server/src/db.ts` still *creates* 26 v1 tables
  (`users`, `credentials`, `sessions`, `notes`, `note_versions`, `note_shares`,
  `messages`, `conversations`, `channels`, `profiles`, `profile_keys`, …) that no
  route can reach. A fresh relay stays empty, but an **in-place upgrade of a v1
  deployment keeps old passkey credentials, note and message ciphertext, and
  profile blobs at rest** — directly against the zero-at-rest posture
  [relay.md](relay.md#state-inventory) states. `db.cleanup()`, run hourly, only
  sweeps *legacy* tables. Dropping them needs a migration that deletes the data,
  not just the DDL.

**Rust core**

- `import_notes`, `import_note_versions`, `import_conversations`,
  `import_contacts` in `store.rs` are registered as **no IPC command** —
  unreachable legacy-migration code kept alive only by their own tests.
  (`import_messages` is live; keep it.)
- Unused columns: `contacts.avatar_ref`, `contacts.profile_key_epoch`.
- Stale comments: `lib.rs`'s `messages_ingest` is described as a seam "while the
  legacy WS is still the transport".

**Web**

- **`web/vite.config.ts` still registers `VitePWA` with
  `injectManifest → src/sw.ts`, and `web/src/sw.ts` is deleted.** The plugin is
  disabled under Tauri via `TAURI_ENV_PLATFORM`, so `tauri build` is fine, but a
  plain `npm run build:web` / `npm run dev:web` — the editor-harness path — runs
  it against a missing source. The `/api` and `/emoji` dev proxies in the same
  file point at the deleted all-in-one server on `localhost:3000`.
- **`web/src/main.ts`** still registers `navigator.serviceWorker` message
  handlers for `notification-navigate` and the `relay-mail` wake. Nothing
  registers a service worker, so both are unreachable.
- **`web/src/lib/password.ts`** is orphaned — imported only by its own test, with
  comments referencing passkeys and a deleted `recovery.ts`. The native password
  KDF lives in `src-tauri/src/vault.rs`. Delete it.
- **`web/src/lib/crypto.ts`** keeps `generateMasterKey` / `sealKey` / `unsealKey`
  and the wrap helpers with no callers; only `encryptBlob`, `decryptBlob` and
  `randomBytes` are still used.
- **`web/package.json`** still depends on `vite-plugin-pwa`, `workbox-*`, `idb`
  and `@simplewebauthn/browser`.
- **`web/index.html`** still carries PWA install metas
  (`mobile-web-app-capable`, `apple-mobile-web-app-*`) with no manifest.
- **`web/src/style.css`** has live rules (~lines 196–232) for `ImageLightbox`,
  `ChatImageGrid` and `AppDrawer` — all deleted components. The z-scale keeps
  `z-drawer` and `z-lightbox` layers with no component using them; that is fine
  (the scale is the contract, not the inventory) but **`CLAUDE.md`'s z-index rule
  names `AppDrawer` and `ImageLightbox` as the examples** and should name
  something that exists.
- Stale comments: `web/src/lib/native.ts`'s header ("callers branch on `isNative`
  and keep using the web paths (IndexedDB/session flows)"), `nativeRelay.ts`
  ("the chat store still orders by legacy `seq`"), `NativeChat.vue`'s
  "edit/delete/react are DM-only" (the code calls the group variants too), and
  `SettingsPage.vue`'s `<!-- Security: passkeys + recovery code -->`.
- `ProfileEntry.nameColor` is an always-null vestigial field.

**Docs**

- `DEPLOY.md` is still passkey-framed ("Passkeys are bound to it", "before anyone
  registers").

---

## D16 — a v8 web client (deferred)

A browser client talking to the standalone relay the way the native app does.
**Deferred deliberately — not a toggle.** The launch is native-only.

This is now a **from-scratch build**, which is a change from how it was
previously framed. There is no legacy web app to "replace" and no dual-mode code
to un-branch: the SPA, its API client, its crypto and its storage were deleted,
and `web/src/` is now UI that only works over `invoke()`. `isNative` is a guard,
not a branch — there is no second implementation behind it. What survives and is
genuinely reusable is the **Vue UI layer**: components, router, editor, theming.
Everything below it has to be written.

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
  keys, ephemeral session, opt-in. A real CSP is non-optional here, unlike in the
  native shell where it is defence in depth.
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

Passkeys, if they return at all, return here: re-scoped to what they are good at
— phishing-resistant bootstrap authentication to a relay, and an opportunistic
(never load-bearing) PRF wrap where PRF genuinely works. They are not part of the
native account model and will not be
([accounts-and-crypto.md](accounts-and-crypto.md#passkeys-are-not-used)).

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

- **Typing indicators and presence.** Neither exists, and neither has a transport:
  the mailbox is durable, acked storage, so a transient signal needs a real
  ephemeral path (a live-WS-only frame that is never queued). Worth noting that
  both are metadata leaks by nature — presence in particular tells the relay when
  you are at your desk — so the design has to decide what the relay learns before
  the mechanism.
- **Opus DTX (silence suppression)** — off deliberately; revisit only if
  bandwidth becomes a problem. Note the trade: continuous transmission keeps the
  rate flat, so speech-activity timing isn't exposed; adding DTX reintroduces
  that leak. See [voice.md](voice.md).
- **In-browser voice media e2e** — a bundled same-origin harness page loading
  `voiceMedia` with a REST `SfuControl`, two fake-mic peers producing and
  consuming, asserting media actually flows. Heavy and timing-sensitive; gated
  behind real-device validation.
- **Biometric ACL gating** on the keychain entry (Secure Enclave / StrongBox
  access control) — the keychain entry is a plain read today. Lands with the
  mobile shell.
- **Message replies.** `ReplyRef` in `shared/src/index.ts` is still the legacy
  `{seq, senderId, preview}` shape and nothing writes or reads it. A v8 reply
  needs the relay-independent message id, not a seq.

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
