# Roadmap

## v3 chat phasing

- **Phase 1** — friends + 1:1 DMs over WebSocket (implemented; see
  [chat.md](chat.md#phase-1--as-built)).
- **Phase 2** — group channels: membership add/remove + leave, epoch re-keying,
  the inviter's share-history choice, per-group permissions + owner/admin roles
  (implemented; see [chat.md](chat.md#conversation-keys--epochs)).
- **Phase 3** — hardening: strict CSP (inline theme/PWA scripts allowed by hash)
  + companion security headers, and content-free background/PWA push
  (implemented; see
  [security.md](security.md#content-security-policy-v3-phase-3--as-built) +
  [notifications.md](notifications.md)).

## v3.1 — Chat polish

Shipped in [#15](https://github.com/jtrobinson1993/notes/pull/15) (merged
2026-06-15).

- Default set of **custom emojis**: a few hundred popular emotes scraped from
  7TV's public API, self-hosted and optimized as static assets; **emojibase**
  for searching local unicode emoji; and per-user **custom, encrypted** emoji
  uploads (optimized as needed). (implemented)
- **GIF search** via KLIPY (free tier), proxied server-side — folded into the
  emoji picker. (implemented)
- **Integration API keys** (KLIPY etc.) live in a gitignored `.env`; see
  `.env.example` for the documented keys. (implemented)
- Chat formatting: reuse the v2.1 live editor (code blocks, spoilers, colors) in
  the composer. (implemented)
- Reactions, replies, and threads — threads open in a resizable side panel.
  (implemented)
- Encrypted image/file attachments in chat (keyed by the conversation key).
  (implemented)

**Also landed (polish beyond the original scope):**

- **Per-user name color** from the curated `NAME_COLORS` palette (readable in
  every theme), picked in Settings → Profile and rendered on sender names.
- **Composer redesign:** square 1:1 attach + emoji/GIF buttons, no visible Send
  button, subtle input tint, themed editor placeholder.
- **App header dropped:** Lock / Settings / Sign out moved into the sidebar; a
  shared conversation header now sits above the chat + thread panes.
- **Settings restructured** into sections with a left-rail nav; passkeys and
  recovery grouped under a **Security** tab.

Deferred items (link previews) moved to [v3.4](#v34--deferred-backlog).

## v3.2 — Editable user profiles ✅ shipped

Implemented — see [profiles.md](profiles.md). The richer profile (bio + avatar)
builds on the v3 display name + name color.

- **Profile data is E2EE to contacts.** The blob (bio, avatar) is encrypted under
  a per-user profile key, wrapped under the owner's master key (cross-device
  recovery) and sealed to each contact — reusing the chat key machinery. Epoch
  re-keying: when a contact loses access (unfriended), the profile key rotates so
  they can't decrypt future updates. (implemented)
- **Visibility setting — "Only allow friends to see my profile" (default on).**
  Friends always; group co-members too when off. Tightening revokes non-friend
  keys. (implemented)
- **Deferred:** Discord-style decorations (animated avatars, profile
  backgrounds/borders) — the original "maybe"; not built.

## v3.3 — Cleanup ✅ shipped

Polish + bug fixes that shipped alongside the v3.2 profile work.

- Sidebar links drop the padding/background hover effect when collapsed; hovering
  shows an instant label tooltip to the right (`SidebarTooltip`). (implemented)
- The "New chat" `+` is now a chat-bubble icon (`message-plus`), styled as a
  solid blue button with a white icon. (implemented)
- The new-chat popover is now a centered modal (`NewChatModal`): heading +
  description, search box, alphabetical friend list with a checkbox per friend
  (select one → DM, or many → a **group**), Cancel / Create, ✕ top-right, blur
  behind, fixed width + max-height 80% on desktop / full-screen on mobile.
  (implemented; backed by real group-conversation creation)
- Reusable modal `AppModal` for primary, blocking actions (reka-ui `Dialog` +
  overlay/blur); `HistoryDialog` and `ShareDialog` refactored onto it.
  (implemented)
- Dropped the "Load older messages" button — older messages auto-load on
  scroll-up, with an "End of message history" marker and preserved scroll
  anchoring. (implemented)

## v3.4 — Link previews + emoji hosting ✅ shipped

- **Link previews** (deferred from v3.1) — **implemented** via an explicitly
  accepted SSRF-guarded server-side OG proxy (`/api/og`); see
  [chat.md](chat.md#link-previews-v34) + [security.md](security.md). Per-user
  setting **off by default** with a privacy tooltip; a preview is only generated
  when **all members** of a chat have it on. The sender's client fetches OG data
  via the proxy and embeds it in the encrypted message; the preview image uses
  click-to-load.
  - DECISION: implement this with a per user setting to turn it on or off (OFF BY DEFAULT), with a tooltip succinctly describing the privacy issue with turning on link previews. Only create link previews when _all members_ of a chat have link previews enabled.
- **Default emoji hosting** — **implemented** as a hybrid: the ~300 committed
  WebP are removed; the server proxies + disk-caches each image from 7TV's CDN
  and serves it from our origin (no per-render IP leak, offline-cacheable), and
  `fetch-emojis.mjs` refreshes the metadata set from 7TV's API. See
  [chat.md](chat.md#custom-emoji--default-7tv-set).
  - Switch to using 7TV api instead of hosting the emojis locally and then heavily cache the api responses (maybe for a day?). Pinia colada will cache the responses locally as well, which you can also place a day cache on, with refetchOnMount: false and refetch on page focus: false

## v3.5 - small bugs / enhancements ✅ shipped

- when a reaction is added to a message for the first time, the pill with the emoji in it should start at 1.5x scale and animate to normal in about .15s _(implemented)_
- when an existing reaction is clicked on to increase the count, the number in the pill should pop up and fall back down in about .15s _(implemented)_
- emoji and attachment buttons still aren't the same height of the chat box. instead of trying to fix their height, just remove the border from the chat box and put that around all 3 elements instead, and vertically center them all. The chat input should be 100% of the height so it's easy to click into. The button icons should become solid variants if they're available, and the buttons themselves should have even padding around them. Each of the buttons should be equal size and square still. _(implemented)_
- new lines in chat messages should be preserved _(implemented)_
- clicking a reply indicator briefly highlights the target message as it scrolls into view; the reply preview is capped + ellipsized so it doesn't wrap on mobile _(implemented)_

## v4 — Chat sidebar

**Chat sidebar + channels — implemented** (see
[chat.md](chat.md#v4--chat-sidebar--channels-as-built)).

- Left-hand sidebar inside all chats. **As built:** the channel sidebar appears
  in **groups**; the 1:1 DM sidebar (pins only) lands with the note-folders work
  below.
- Collapsible; persist open/closed state. Collapse/open icon at the top.
  (implemented)
- An edit button at the bottom of the open sidebar makes channels editable /
  reorderable / deletable. (implemented — rename / drag-reorder (up-down arrows
  as an accessible fallback) / delete; managers only)
- Ability to create "channels" à la Discord, with a type (text or voice). Voice
  channels are structural here; the voice functionality itself lands in v6.
  (implemented)
  - DECISION: channels share the conversation key/epochs (no extra key
    distribution) and add per-channel read state + unread; `seq` stays
    conversation-unique (the reply/thread/edit anchor) rather than restarting per
    channel. The general channel is virtual (`channelId === conversationId`), so
    DMs/threads are unchanged.

### Note folders (organization) — implemented

See [notes.md](notes.md#folders--organization-v4).

- Organize notes into folders. (implemented — nestable folders via drag-to-nest;
  a note is in at most one folder)
- Pin a note or note folder into the chat sidebar. (implemented — per
  conversation; the 1:1 DM sidebar is pins-only)
- Create a new note / note folder from the chat sidebar; it also appears in your
  notes view. (implemented — via the pin picker)
  - DECISION: folders + note→folder assignment + pins are **personal
    organization**, stored as one master-key-encrypted settings blob (like tag
    colors) — they never touch the E2EE note payloads or the server note model,
    so they apply to shared-with-me notes too, and **pinning never shares** the
    item (sharing is v5).

(Sharing folders with chat participants and the associated permissions are their
own crypto-heavy feature — see **v5**.)

## v5 — Note & folder sharing

Per-object access control on top of E2EE — effectively the same
key-distribution problem as chat membership, so reuse that machinery:

- Share an entire folder of notes from the notes view (not just individual notes).
- Share an entire folder of notes AND channels from the chat sidebar.
- **No authoritative "group permissions."** Sharing a folder **recursively grants
  the permission to each individual child object** — it's purely a UX convenience
  to avoid granting permissions one-by-one. Permissions live on the objects
  themselves, not on the folder.
- Adding a note/folder to a chat sidebar does **not** automatically expose it to
  everyone in the chat. On add, present a UX to optionally grant view permission
  to other participants — individually or to all at once.
- **Revocation:** removing a participant's access must rotate the note/folder key
  (epoch re-key) so they can't read future updates. Prior plaintext they already
  held is considered compromised — document that boundary.

### Decisions (confirmed)

- **Recipients may be non-friend conversation co-members.** Sharing is no longer
  strictly friends-only: you may grant access to any participant of a shared
  conversation (friends-of-friends). This **relaxes the friends-gate invariant**
  in `CLAUDE.md` for the *sharing* path — update that doc when implementing.
- **Channels become per-object permissioned ("private channels").** This
  supersedes the v4 model where every member shares the conversation key and sees
  every channel: a channel gets its own key/membership and is granted to specific
  people. (Existing v4 channels migrate to "everyone in the conversation has
  access".)
- **Folder share = one-time recursive snapshot.** Sharing a folder grants its
  current children individually; there is **no** persistent folder→recipient
  record, and notes/channels added later are NOT auto-shared.
- **Delivery:** one PR covering notes-view + chat-sidebar folder sharing, channel
  sharing, revoke-with-key-rotation, and the grant-on-add-to-sidebar UX.

## v6 — Voice ✅ implemented (`v6-voice`)

E2EE voice over WebRTC — **implemented**; see **[voice.md](voice.md)** for the
as-built design (pending a manual two-browser audio check). Two surfaces:

- **Voice channels** — joinable persistent rooms (the voice-type channels created
  in v4).
- **Direct voice calls** — 1:1 (and small-group) calls with ringtones and an
  answer / ignore prompt on the callee's side.

No plans for video (see v7).

### Decisions (confirmed)

- **SFU, never mesh — including 1:1.** All media flows through a server-side
  forwarding unit so **no participant ever sees another's IP**. (Mesh would leak
  peer IPs.)
- **Embedded [mediasoup](https://mediasoup.org) v3**, an **npm dependency inside
  the existing Node process** — not a standalone service (rules out
  LiveKit/Janus/ion). Prebuilt worker binaries → install stays one `docker run`.
  The SFU is also the relay, so **no separate TURN server**.
- **Always end-to-end encrypted** via the WebRTC Encoded Transform API
  (`RTCRtpScriptTransform`) — the server only forwards opaque frames. Works in
  Chrome/Edge (small shim), Safari, Firefox/Zen. No "unencrypted for quality"
  mode (encryption costs no meaningful latency/quality).
- **Media key reuses the chat/v5 key machinery**; epoch **rekey on join/leave**
  (forward secrecy on removal). Voice is ephemeral — no at-rest plaintext.
- **Scope = full parity:** mute, deafen, push-to-talk, per-person volume,
  who's-speaking highlight (client-side, zero server metadata), connection-quality
  indicator.
- **Incoming 1:1 calls ring all linked devices; first to answer wins** (reuses
  content-free Web Push to wake devices).
- **Voice-room presence is visible to all channel members** (Discord-style).
- **No recording** (impossible server-side; no client feature either).
- **No silence suppression (Opus DTX) in v6.** Mics transmit continuously;
  **future follow-up** to add DTX only if bandwidth becomes a problem. Bonus:
  continuous transmission keeps the rate flat, so speech-activity timing isn't
  exposed (adding DTX later would reintroduce that leak; decoy traffic could then
  mitigate it).
- **Scale:** ≤ ~10 per room, < 10 concurrent rooms; self-hosted on home hardware
  (home **upload** bandwidth is the ceiling, not CPU). Without DTX these figures
  are the sustained rate, not a peak.

## v8 + v11 — Local-first across minimal relays: your data lives on your devices

**Status: long-term goal, large rework, exploration phase. Direction is chosen
(below); the individual decisions are open. Nothing here is built. This section
captures the digging we need to do *before* committing engineering.**

This milestone **absorbs the former v8 "multiple servers (Discord-style)"
plan**: multi-server survives as a **multi-relay client** (connect to several
relays, aggregate them in one UI), but v11's local-first decisions **supersede**
v8's per-server-passkey approach — there is one local master seed and per-relay
*derived* identities authenticated by the **device key**, not a separate passkey
and master key per server (see [D4b](#decisions-to-make)).

### Decision & why

Two earlier shapes were considered and dropped. **Centralized "host everything"
(Discord-style)** dies not on infra cost (cents/user/month) but on the personnel
and legal load it forces on the operator — mandatory abuse/CSAM reporting,
law-enforcement + data-subject requests, DMCA, 24/7 on-call, and custody of
*everyone's* metadata. A small team / non-profit can't carry that. **Splitting an
official web frontend from self-hosted backends (Matrix/Element shape)** is better
but still leaves each backend holding durable ciphertext (a honeypot at rest) and
keeps the web served-code trust problem.

**Chosen direction: local-first + a minimal relay.** Durable data lives
**encrypted on the user's own devices** (old-Skype-style local history, but
E2EE). The server stores **nothing at rest** — it is a transient, encrypted
**store-and-forward relay** plus a key directory and connectivity (STUN/TURN) for
voice. This is the strongest data-at-rest posture: **no honeypot to subpoena,
breach, or seize.** It also flips the served-code problem in our favour — a
**signed, store-distributed native app** is the *strongest* answer to "is the
client trustworthy," far better than web delivery.

The two costs we accept up front:

- **It needs native apps on every platform — desktop *and* mobile.** Browser
  storage (IndexedDB) is quota-limited and *evictable* (Safari/iOS evict
  non-installed web-app data after ~7 days; all engines can evict under storage
  pressure). A full local history + media needs the real filesystem, so we need
  real apps on **Windows, macOS, Linux, iOS, and Android** — a mobile PWA won't
  do, since mobile browsers evict just as aggressively.
- **No durable server backup ⇒ data lives or dies with your devices.** Onboarding
  a new device and surviving device loss become *our* problem to solve
  device-to-device, not the server's (see **D8**). This is a deliberate trade for
  zero server-side data.

We are **not** going pure peer-to-peer (no server at all): reliable asynchronous
delivery, groups, and NAT traversal all require *someone* to hold an encrypted
message while a recipient is offline, so a thin relay stays. (Pure P2P / DHT is a
non-goal — see below.)

### Architecture

- **Client = native app.** Holds all durable data in a local encrypted store,
  does all crypto, and works **fully offline**. Talks to a relay only to reach
  other people or other devices.
- **Relay = minimal, stores nothing at rest.** Encrypted store-and-forward
  mailbox (hold ciphertext until each recipient device acks, then delete —
  Signal-style), the `handle → public-key` directory, content-free push,
  STUN/TURN + voice SFU signaling. Self-hostable; this is a *lean retention
  profile* of today's server, not a new codebase.
- **Sync model = local-first.** Append-only chat messages replicate by sequence;
  **mutable shared state (notes, edits, reactions, read state) uses CRDTs** so
  offline edits merge conflict-free. All updates are encrypted and relayed as
  **opaque blobs** — the relay never sees plaintext or CRDT structure.
- **Multiple relays (absorbs v8).** The client can connect to **several relays at
  once** and aggregate them in one UI; each relay is an independent instance you
  add by its **HTTPS URL + invite**. Friends and groups stay **per relay**;
  groups spanning two relays would need federation (a non-goal). Cross-relay
  identity/auth is **device-key based with per-relay derived identities** (D4b),
  not a per-server passkey.

This inverts today's design (server holds all ciphertext; thin web client; auth
*and* data need the server). After v11, the **device** is the source of truth and
the server is optional plumbing.

### Decisions to make

#### Client platform

**D1 — App framework (desktop + mobile, all five platforms).** Hard requirement:
**Windows, macOS, Linux, iOS, and Android**, reusing the existing Vue + CodeMirror
app from **one web codebase** (a UI rewrite, and per-OS native apps, are non-goals
— too much duplicated work). Electron alone is **desktop-only**, so mobile forces
the choice. Candidates:
  - **Capacitor (iOS/Android) + Electron (desktop)** — two native shells wrapping
    the *same* web app. *Pros:* both are **mature**; Electron gives pixel-identical
    desktop rendering + Node/SQLite with **no browser quota/eviction** (storage
    goes through Node, not the sandboxed web APIs — this is what kills the storage
    worry); Capacitor is the standard web→mobile bridge with first-class native
    plugins for SQLite, biometrics, secure storage, and push. *Cons:* two shells to
    maintain; Electron is heavy (~120–150 MB / 200–400 MB RAM).
  - **Tauri v2 (all five from one project)** — Rust core + system webviews,
    desktop *and* iOS/Android. *Pros:* one shell stack, tiny binaries (~5 MB),
    official SQLite plugin. *Cons:* per-OS webview differences (Linux WebKitGTK
    lags); **WebAuthn/passkey support is worst-in-class** (esp. Linux); mobile
    targets are younger/less proven than Capacitor + Electron.
  - **Flutter / React Native / .NET MAUI** — true single cross-platform stack but
    a **UI rewrite** off web tech (lose Vue + CodeMirror + the whole editor).
    Rejected on cost.
  - **Note on passkeys:** native shells generally **don't expose WebAuthn PRF**
    cleanly (Electron needs a per-OS native module — only macOS has one today,
    Jan 2026; Tauri's Linux webview is effectively broken), which is why local
    unlock shifts to OS keychains/biometrics in **D3**. Mobile is actually the
    *strongest* case there (hardware secure enclaves).
  - **Recommendation: Capacitor + Electron** for maturity and maximal reuse of the
    current app, with **Tauri v2** as the single-stack alternative to re-evaluate
    as its mobile + passkey stories harden. Either way it's **one web codebase**
    behind native shells. *Status: open — Capacitor+Electron (two mature shells) vs
    Tauri v2 (one younger stack).*

**D2 — Local storage engine.** Move durable data to **SQLite** (e.g.
better-sqlite3 in Electron's main process) + the filesystem for encrypted
attachment blobs; today's IndexedDB (`idb.ts`) is renderer-sandboxed and
eviction-prone. Encrypt at rest: either per-field/blob under MK (as today) or
whole-DB (SQLCipher). Storage is now bounded by the user's disk, not a quota.
*Status: open — SQLite-in-main vs keep IndexedDB; SQLCipher vs field-level.*

**D3 — Local unlock primitive (the passkey problem).** Because passkey **PRF** is
unreliable in desktop shells (D1), the *local vault* unlock should lean on
**native** primitives rather than WebAuthn: protect MK at rest with the **OS
keychain / secure store** — macOS Keychain, Windows DPAPI / Credential Manager,
Linux Secret Service, and on mobile the **iOS Keychain / Secure Enclave** and
**Android Keystore (StrongBox)** — gated by **OS biometrics**, with the existing
**password (Argon2id)** path as the portable fallback and the **recovery code**
retained. Mobile is the *strongest* case here (hardware-backed enclaves + Face/
Touch ID). WebAuthn PRF becomes optional (or via per-OS native modules later).
Crucially this makes unlock **fully local/offline**. *Status: open — OS-keychain
+ biometric vs invest in per-OS passkey/PRF native modules.*

#### Identity, auth & connectivity

**D4 — Offline auth & use (big shift).** Unlock decrypts the local MK **with no
network**, so notes and local chat history are fully usable **offline**. The relay
is contacted only to send/receive *new* traffic, sync devices, or reach contacts.
This **decouples "unlock local vault" (offline) from "authenticate to relay"
(online bearer token)** — today login is server-verified, so this is a real
redesign of the auth flow. *Status: open — confirm offline-first unlock; relay
token lifetime/refresh.*

**D4b — Multi-relay auth & identity (the absorbed v8).** With multiple relays
(Architecture, above), the cross-relay primitive is the **device identity keypair**
(the Ed25519/X25519 device key from
[device-linking](accounts-and-crypto.md#device-linking-proposed--not-yet-built)),
**not a passkey**: to authenticate, the device **signs the relay's challenge** and
the relay returns a bearer token (D4). Adding a relay is "enter its HTTPS URL,
accept its invite, prove your device key, claim a handle," all behind the *same*
local biometric unlock — no per-server passkey ceremony, no per-server master key. **Decided:** derive a **distinct per-relay
identity key from the one local master seed**, so independent relays **cannot
collude to correlate** the same user across servers — chosen over presenting one
shared key everywhere. A "same handle on every server" identity is a non-goal
regardless: each relay mints handles independently, so cross-server handle
availability was never guaranteed. This **supersedes v8's** "separate account,
passkeys, master key per server" line. *Status: per-relay-derived identity
decided; open — challenge/token protocol details, and whether a future opt-in
global directory could offer a same-handle UX without re-linking identities.*

**D5 — Key directory & MITM (unchanged necessity).** The relay still serves the
`handle → X25519 public key` directory, so a malicious/compromised relay can
**substitute a contact's key and man-in-the-middle key exchange** even though it
stores no content. Required regardless of the storage model: **fingerprint /
safety-number verification** (out-of-band human compare, reusing the device-link
SAS pattern from [accounts-and-crypto.md](accounts-and-crypto.md#device-linking-proposed--not-yet-built)),
with **key transparency** (append-only auditable log — CONIKS / Apple Contact Key
Verification / WhatsApp-style) as the scalable follow-up. *Status: open —
fingerprints are non-negotiable; pick the transparency design + when.*

**D6 — Relay retention & transport.** Define the mailbox precisely: ciphertext
held only until every recipient device acks, then deleted; a TTL for devices that
never come back; group fan-out; and exactly what routing metadata the relay can
see (sender/recipient/timing — candidates for sealed-sender later). Confirm
transport is **via the relay, not P2P** (reliability + NAT). *Status: open —
TTLs, ack protocol, metadata-minimization scope.*

**D7 — Connectivity, voice & push.** The relay keeps **STUN/TURN** + the mediasoup
SFU for voice (already required; voice has no at-rest data). **Push changes for
mobile:** web-push/VAPID is desktop/web-only — native apps need **APNs (iOS)** and
**FCM (Android)**, so the content-free push path must fan out across web-push +
APNs + FCM behind one abstraction. iOS also restricts background execution, so
background **sync largely happens on push-wake or foreground**, not continuously —
which shapes the relay's delivery/queue behaviour (D6). *Status: open — push
provider abstraction; mobile background-sync strategy.*

#### Multi-device & data transfer (no server backup)

**D8 — New-device onboarding + history transfer (the hard one).** No durable
server backup (by choice). Instead, use the relay as a **transient conduit**
between *your own* devices:
  1. **Pair via QR.** The new device generates an ephemeral X25519 keypair and
     shows its *public* key as a QR; the primary scans it, both show a **SAS** to
     confirm no MITM, and the primary `sealKey`s MK to the new device (reuses the
     existing device-link design — MK only ever crosses sealed).
  2. **Bulk history transfer.** While both are online during pairing, the primary
     **streams its encrypted local store** (or a CRDT state snapshot) to the new
     device through the relay as opaque blobs — *"scan the QR on your primary
     device to sync."* Nothing durable lands on the server.
  3. **Ongoing sync.** Every device is a **full replica**; the relay queues
     encrypted updates for offline devices; CRDTs merge on reconnect.
  - **Tradeoffs to document and decide:** (a) onboarding **requires an existing
    device online**; (b) if **all** devices are lost at once, **data is gone** —
    the recovery code restores *identity*, not *history*. Mitigations to weigh: a
    soft requirement of ≥2 devices, and/or an **optional, user-initiated, local
    encrypted export file** the user stores wherever they like (explicitly **not**
    server-side). *Status: open — accept "need 2 devices," and/or offer a
    user-controlled offline backup export?*

**D9 — Conflict model (CRDTs).** Adopt **Yjs** for mutable synced state. It has an
official **CodeMirror 6 binding (`y-codemirror.next`)** — the app already uses
CodeMirror 6 — and Yjs is transport-agnostic, so we encrypt its **binary update
blobs** under the relevant key and relay them opaquely (proven pattern; Matrix
relays E2EE Yjs this way). Local persistence via `y-indexeddb` or a SQLite
adapter. Concurrent offline edits **merge deterministically, conflict-free**.
Caveat to document: CRDT convergence is *conflict-free*, not *semantically
perfect* — two people editing the same sentence offline merge into a deterministic
but possibly awkward result; acceptable for notes. *Status: open — Yjs vs
Automerge (Yjs favoured: CodeMirror binding, text performance, ecosystem); which
state is CRDT vs simple last-writer-wins.*

#### Feature implications

**D10 — Notes (answers the specific questions).**
  - **Where shared notes live:** on **each participant's device**, encrypted under
    the per-note key shared via the sealed-box mechanism from
    [v5](#v5--note--folder-sharing). The relay only forwards encrypted Yjs updates
    and queues them for offline members — it stores **no note**.
  - **Reconciling offline edits on two devices:** the Yjs CRDT **auto-merges**
    divergent edits on reconnect — this is the entire reason to adopt a CRDT, and
    it covers both "my two devices" and "two different users editing a shared
    note."
  - **Version history:** maps onto Yjs's update/snapshot history; decide retention
    (the current version-history feature must be re-expressed over CRDT state).
  - **Offline + auth:** **yes — notes work fully offline.** Unlock is local (D3/D4)
    and the store is local; the network is only needed to *share* changes with
    others or sync a new device.
  - **Migration:** existing server-stored notes must be pulled down and imported
    into the local store on first run of the native app.
  *Status: open — version-history-over-CRDT, migration tooling.*

**D11 — Chat implications.** Append-only **messages are immutable + ordered by
`seq`** → simple device replication (no CRDT needed); **edits/reactions/read
state are mutable** → CRDT or last-writer-wins. History becomes a **local log**
(Skype-style). Groups still need the relay for fan-out + offline queueing.
*Status: open — which mutable chat state is CRDT.*

**D12 — Trust / distribution (improved by going native).** A **signed,
store-distributed native app** plus **reproducible builds** is the strongest
answer to the served-code problem — strictly better than the web delivery the
previous v11 draft worried about. The web app, if kept at all, becomes a
**reduced-capability "online-only" client** (it can't hold full local history),
or is dropped. *Status: open — keep a thin web client or go native-only;
code-signing + reproducible-build pipeline.*

### Non-goals

- **Pure peer-to-peer / DHT.** Availability (offline delivery), groups, and NAT
  traversal all need a relay; a thin relay is kept deliberately.
- **Any durable server-side content store or server-side backup** — the whole
  point. (An *optional, user-controlled, offline* export is the only backup form
  on the table; see D8.)
- **Federation** across relays (groups spanning two relays) — cross-relay
  identity, key distribution, and message relay are out of scope (this was the v8
  exclusion, carried forward).

### Suggested phasing (large rework)

1. **Native shells** (desktop + mobile) wrapping the existing app; move durable
   storage to local SQLite (D1, D2); import existing server data on first run.
2. **Local offline unlock** — OS keychain / biometric / password, decoupled from
   server auth (D3, D4).
3. **Minimal relay** — strip durable storage down to the encrypted mailbox +
   directory + push + STUN/TURN (D6, D7).
4. **CRDT sync** — Yjs for notes + mutable state, encrypted-blob relay, offline
   merge (D9, D10, D11).
5. **Multi-device** — QR pairing + device-to-device history transfer, no server
   backup (D8).
6. **Key verification** (D5) — fingerprints as the safety gate; key transparency
   later.

### Open questions

- **Framework:** Capacitor + Electron (two mature shells) vs Tauri v2 (one younger
  stack) to cover all five platforms — Win/macOS/Linux/iOS/Android? (D1)
- **Mobile push:** unify content-free push across web-push, APNs, and FCM behind
  one relay abstraction; settle the iOS background-sync strategy (D7).
- **Single-device data-loss:** accept "you need ≥2 devices," and/or ship an
  optional user-controlled **offline** encrypted backup export? (No server-side
  backup either way — D8.)
- **Web client:** keep a reduced-capability online-only web client, or go
  native-only? (D12)
- **Desktop passkeys:** invest in per-OS native passkey/PRF modules, or settle on
  OS-keychain + biometric + password for local unlock? (D3)
- **Key transparency** design + whether it's v11-scope or a follow-up (D5).
- **Multi-relay auth:** device-key challenge/token protocol details, and whether
  an opt-in global directory should later enable same-handle-across-servers UX
  without re-linking per-relay identities (D4b).

## v12 — Video streaming in voice channels?

Far future — not intended for a long time.

- What strain would this put on server-host hardware?
