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

## v6 — Voice ✅ shipped

E2EE voice over WebRTC — **implemented and merged into `main`**; see
**[voice.md](voice.md)** for the as-built design. Verified solo with two test
accounts (audio works end-to-end); a two-person audio-*quality* check is still
pending. Two surfaces:

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

## v8 — Local-first across minimal relays: your data lives on your devices

**Status: long-term goal, large rework. Direction is chosen and **all design
decisions D1–D15 are now resolved** (each marked *decided* below; see also
"Open questions", all closed). **Nothing here is built yet** — the next step is
implementation per "Suggested phasing." This section captures the design digging
done *before* committing engineering. **Release strategy (decided): one
release** — all six phases land on this branch/PR; no incremental releases of
partial phases. The hard cutover (D12) happens when the branch merges + ships;
the currently-deployed app keeps running unchanged until then.**

This milestone **folds in the earlier "multiple servers (Discord-style)"
plan**: multi-server survives as a **multi-relay client** (connect to several
relays, aggregate them in one UI), but the local-first decisions here
**supersede** that plan's per-server-passkey approach — there is one local master
seed and per-relay *derived* identities authenticated by the **device key**, not a
separate passkey and master key per server (see [D4b](#decisions-to-make)).

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
- **Multiple relays (the folded-in multi-server plan).** The client can connect to **several relays at
  once** and aggregate them in one UI; each relay is an independent instance you
  add by its **HTTPS URL + invite**. Friends and groups stay **per relay**;
  groups spanning two relays would need federation (a non-goal). Cross-relay
  identity/auth is **device-key based with per-relay derived identities** (D4b),
  not a per-server passkey.

This inverts today's design (server holds all ciphertext; thin web client; auth
*and* data need the server). After v8, the **device** is the source of truth and
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
  - **Decided: Tauri v2** — one shell stack across all five platforms with tiny,
    performant binaries; **Electron's ~150 MB / 200–400 MB weight was the deciding
    con** against the two-shell route, and D3 (below) moving primary local unlock
    to OS keychain + biometric largely defuses Tauri's weak passkey/PRF story.
    **Fallback: Capacitor + Electron** if Tauri hits a blocker — primarily if the
    **Linux WebKitGTK webview can't render the CodeMirror editor acceptably**
    (being verified now via a containerized WebKitGTK screenshot harness), and
    secondarily if Tauri's younger mobile targets prove disqualifying. Either way
    it's **one web codebase** behind native shells. *Status: decided — Tauri v2.
    The Linux WebKit editor-render gate **passed**: driving the real editor in
    Linux WebKit vs Linux Chromium (Playwright container, `web/dev/webkit-render-check.mjs`)
    gave **identical caret-offset motion across concealed markers** (the
    layout-geometry-dependent behaviour) and correct WebKit live-preview
    rendering of concealed markup. (A font-weight discrepancy in the Chromium
    *reference* screenshot traced to the headless container's minimal font set /
    faux-bold synthesis — a container artifact, not an engine difference.)
    Capacitor + Electron remains the documented fallback if a later blocker
    appears.*

**D2 — Local storage engine. Decided: SQLite in the Tauri Rust core + SQLCipher
whole-DB at rest.** Durable data moves to **SQLite**, accessed from the webview
through the **Tauri Rust core** (async IPC commands / the Tauri SQL plugin), with
the **filesystem for encrypted attachment blobs**. This escapes browser
**quota/eviction** — the whole point of going native (D1); today's IndexedDB
(`idb.ts`) is renderer-sandboxed and evictable, so it's dropped for the native
durable store (a reduced/online-only web client — D12 — could still use IndexedDB,
but it wouldn't hold full local history). Cost: a real refactor of `idb.ts` data
access into IPC calls.
  - **At-rest model — SQLCipher (whole-DB), *composed with* the unchanged E2E
    content encryption.** The local store holds **usable (decrypted) data** so
    local **search/queries** work, and the whole DB — rows, indexes, **metadata** —
    is encrypted at rest via **SQLCipher**, its key held in the **OS keychain**
    and biometric-gated (**D3**). Chosen over field-level ciphertext, which would
    keep DB metadata in cleartext and **kill local search** over content. E2E
    content keys / MK-sealing are **separate and mandatory** regardless — they
    protect data in the relay mailbox + transit; SQLCipher only adds
    device-at-rest protection of the local file. *Status: decided.*

**D3 — Local unlock primitive (the passkey problem).** Because passkey **PRF** is
unreliable in desktop shells (D1), the *local vault* unlock should lean on
**native** primitives rather than WebAuthn: protect MK at rest with the **OS
keychain / secure store** — macOS Keychain, Windows DPAPI / Credential Manager,
Linux Secret Service, and on mobile the **iOS Keychain / Secure Enclave** and
**Android Keystore (StrongBox)** — gated by **OS biometrics**, with the existing
**password (Argon2id)** path as the portable fallback and the **recovery code**
retained. Mobile is the *strongest* case here (hardware-backed enclaves + Face/
Touch ID). WebAuthn PRF becomes optional (or via per-OS native modules later).
Crucially this makes unlock **fully local/offline**. **Decided: OS keychain +
biometric is the primary local unlock; PRF stays optional per-platform (never
load-bearing); password (Argon2id) is the portable cold-start path; recovery
code retained.** Chosen over investing in per-OS passkey/PRF native modules —
D3a (below) removes the only requirement that would have forced robust
cross-platform PRF, so the weak Linux-desktop PRF story is a non-issue.
*Status: decided.*

**D3a — Passwordless cold-start on a fresh, unpaired device: not required.** A
brand-new device with no other device present to pair with unlocks via the
**password (Argon2id)** path, not passwordless. Rationale: such a device holds
**no local history anyway** (history lives on devices — D8; a lone new device
has none until it pairs), so "cold-start" here only re-establishes
identity/relay access, not data recovery — a natural fit for the password path.
Rejecting the "must be passwordless" alternative avoids needing robust
cross-platform PRF (broken on Linux desktop — D1). Note the password cold-start
*requires* a relay-held **wrapped-MK escrow** to exist — originally resisted
here as denting the zero-at-rest posture, later adopted deliberately as **D15**
(tiny key blobs under user-held secrets are not the content honeypot the
posture exists to avoid). The model is therefore: biometric/
keychain day-to-day on provisioned devices, **QR device-linking (D8)** to
onboard a new device from an existing one, and **password as insurance** for the
no-other-device case. *Status: decided.*

#### Identity, auth & connectivity

**D4 — Offline auth & use (big shift).** Unlock decrypts the local MK **with no
network**, so notes and local chat history are fully usable **offline**. The relay
is contacted only to send/receive *new* traffic, sync devices, or reach contacts.
This **decouples "unlock local vault" (offline) from "authenticate to relay"
(online bearer token)** — today login is server-verified, so this is a real
redesign of the auth flow. **Decided — two independent layers:**
  - **(A) Vault unlock (local, user-facing).** A **per-device re-lock setting**:
    *"Stay unlocked"* vs *"Require unlock when the device locks / after N minutes
    idle."* This is the only knob the user sees; it gates *reading* local data,
    nothing else.
  - **(B) Relay token (network, under the hood).** **Short-lived access token**
    that the device **silently re-signs** using its **device key** (D4b) — no
    biometric prompt, since the device key sits in the OS keychain and gates the
    *relay handshake*, not the vault. Chosen over a long-lived token because it
    makes **revocation actually work with minimal relay state** (to kill a lost
    device, stop honoring its refresh → its live token expires within the window)
    and a **leaked token self-heals** (worthless after the window); a long token
    would need a server-side blocklist (at-rest state, against the zero-at-rest
    goal) and stays valid until explicitly revoked.
  - **Payoff of keeping A and B independent:** because the relay token refreshes
    on the *device key*, not the MK, the **relay connection stays alive to receive
    pushes/queued sync while the vault is locked** — notifications still arrive;
    you re-unlock only to *read*.
  *Status: decided.*

**D4b — Multi-relay auth & identity (the folded-in multi-server plan).** With multiple relays
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
availability was never guaranteed. This **supersedes the old multi-server** "separate account,
passkeys, master key per server" line. **Challenge/token protocol decided:** the
relay issues a **random nonce**; the device signs a payload that includes both
the nonce **and the relay's own identity** (so a malicious relay can't replay
your signature to authenticate as you to a *different* relay); the relay returns
the **short-lived token** (D4).

**Friend-invite codes (self-describing, redeemed in-app).** An invite encodes
{relay routing hint + relay key fingerprint + one-time invite token} so the
recipient never manually picks a server. **Two carriers for the same token:**
(1) **in-app** — shared through an existing Accord chat/flow, the client
recognizes a **known prefix** and renders it as a tappable "add friend" button
(fully reliable, no OS deep-linking, app-controlled); (2) **out-of-app** — a
**universal / App Link** (`https://<app-domain>/i/…`) with the token + relay
fingerprint in the URL **`#fragment`** (never sent to any server) that the
installed app **intercepts**, falling back to a **static, inert "open in Accord"
page** when the app isn't installed. **Redemption always runs through the app
client, never a browser session** — so no Referer / User-Agent / cookie /
fingerprint leak, and the fragment keeps the token + relay-fp off the wire.
Cross-relay *identity* is not exposed (per-relay identities, above); residual
**IP-based correlation** between colluding relays is a general metadata property
handled in **D6**, not invite-specific (mitigated by Tor/VPN, not link format).
*Status: per-relay-derived identity + challenge protocol + invite format decided;
open — whether a future opt-in global directory could offer a same-handle UX
without re-linking identities (see also D4c).*

**D4c — Cross-relay contact continuity (persistent multipath redundancy).**
**Adopted.** A user may **permanently link** their identities on two or more
relays for a given contact via an **E2E, relay-invisible "same-me" attestation** —
signed by an **already-verified** relay identity, so the friend's client
**auto-trusts** the added relay key (**D5 verify-once** — no fresh out-of-band
SAS). The link is **additive, not a migration**: a contact becomes reachable via
{relay A, relay B, …}; if A is offline (outage, update, or shutdown), new
messages **route via B**, appended to the **single local conversation thread**.
History is local (D8/D11), so a relay dying never loses history — this only
restores the *live channel*. **Preserves D4b unlinkability:** the attestation is
exchanged **friend-to-friend, never posted to a relay**, so relays still cannot
correlate you across servers — only your friend's client knows. **Requires a
relay-independent message id** (sender-assigned logical id/clock, not per-relay
`seq`) for cross-path send/dedup — folded into **D11**. The same signed-pointer
principle also covers a relay **changing its URL** (relay signs a "moved to
<newURL>" record against its **pinned key**; clients verify and update the hint).
**Federation stays out** (no relay-to-relay; cross-relay groups remain a
non-goal) — this is **1:1 (and all-members-migrate groups) only**. *Status:
decided — **full v8 scope** (failover routing + cross-path dedup + contact-link
UI ship in v8, not deferred).*

**D5 — Key directory & MITM (unchanged necessity).** The relay still serves the
`handle → X25519 public key` directory, so a malicious/compromised relay can
**substitute a contact's key and man-in-the-middle key exchange** even though it
stores no content. Required regardless of the storage model: **fingerprint /
safety-number verification** (out-of-band human compare, reusing the device-link
SAS pattern from [accounts-and-crypto.md](accounts-and-crypto.md#device-linking-proposed--not-yet-built)),
with **key transparency** (append-only auditable log — CONIKS / Apple Contact Key
Verification / WhatsApp-style) as the automatic, everyone-gets-it default.
**Decided — both ship in v8:**
  - **Key-transparency log (default protection).** A **per-relay**, append-only,
    **privacy-preserving** auditable key directory (**AKD / CONIKS lineage** —
    the engine behind WhatsApp KT & Apple CKV; lean on **Meta's open-source AKD**
    primitives). Clients silently verify **inclusion + consistency proofs** on
    every fetched key and **self-audit their own binding** (only you know your real
    key, so a relay inserting a fake key for you trips *your* alarm). Per-relay
    identities → per-relay directories → per-relay logs; no cross-relay log
    (federation stays out). Catches relay **equivocation** automatically for the
    ~99% who never manually verify.
  - **SAS fingerprint verification (server-trust-free anchor).** Out-of-band human
    compare (reuses the **device-link SAS** screen — near-free). Trusts **no
    server at all**, so it covers the log's one early weakness: detecting a relay
    **split view** otherwise relies on a **gossip/auditor ecosystem** that won't
    exist yet when few relays are running. Kept in v8 precisely for that bootstrap
    phase; also the highest-assurance manual check thereafter.
  - Note: the log's non-equivocation guarantee ultimately depends on **auditing
    actually happening** (root gossip / independent auditors) — a maturity concern
    to track, and the reason SAS is not deferred.
  - **v8 auditing (decided — specified, not deferred):**
    - **Self-audit (baseline):** each client continuously verifies its *own* key
      binding against the log.
    - **Passive gossip via root-piggybacking:** every E2E message / CRDT update to
      a contact on a **shared relay** piggybacks the sender's latest seen **signed
      log-root(s)**; the recipient checks consistency (append-only ⇒ one root must
      provably extend the other). **Inconsistent roots = split-view alarm.** Zero
      extra infra — it rides existing traffic, and friends/groups are per-relay so
      the people you talk to co-observe the same log.
    - **Well-known roots endpoint:** the relay publishes its signed roots at a
      stable URL so anyone can fetch and verify the log's history for free.
    - **Third-party auditors = independent parties, NOT a service we run (post-v8
      ecosystem).** An auditor's whole value is being **independent of the relay
      operator** — an operator auditing its *own* log proves nothing (a malicious
      operator just runs one that rubber-stamps). So v8 does **not** build or
      operate auditors; it **enables** them: the public roots endpoint above, plus
      publishing the **log-format spec + an open-source reference auditor** so
      independent parties — researchers, privacy watchdogs/NGOs, power users, even
      *other relay operators* — can run one and raise the alarm on a fork/rewrite
      (same shape as Certificate Transparency). Crucially, v8 already gets most of
      this from **users acting as distributed auditors via the piggyback gossip**
      above; dedicated independent auditors add always-on, whole-log coverage +
      public accountability — an **enhancement, not a dependency**.
      - **README action (at build):** add a short **"Verifying this relay's key
        transparency"** section to the root `README.md` — how to fetch the roots
        endpoint + run the reference auditor, and our **recommendation to rely on
        *independent* auditors** (explicitly: operator-run auditors carry no trust
        value); include pointers/recommendations for third parties who want to run
        one.
    - **On detection:** raise the key-integrity alarm (see UI surface) and fall
      back to **SAS** for affected contacts.
  *Status: decided — transparency log + SAS both in v8; self-audit + piggyback
  gossip + well-known roots endpoint specified. Third-party auditors are
  independent (post-v8 ecosystem we enable, not operate); README to document the
  auditor recommendation at build.*

**D6 — Relay retention & transport. Decided.**
  - **Mailbox mechanics.** Ciphertext held per recipient *device* only until that
    device **acks**, then deleted; fully gone once all devices ack. **Undelivered
    TTL ~30 days** (a device offline past TTL re-syncs from another of the user's
    devices — D4c/D8 — so TTL expiry ≠ data loss). **Group fan-out:** sender
    uploads once (payload under the shared group key); the relay copies into each
    member's queue, acking/deleting per member. **Transport via the relay, not
    P2P** (NAT/availability; P2P stays a non-goal).
  - **Metadata — sealed-sender in v8.** The relay does **not** learn the explicit
    **sender**; it sees only **recipient + timing + sender IP**. Reach is gated by
    a **delivery-token capability** model: each friend holds a token you issued (on
    friending, via the invite flow) and the relay checks the **token**, not
    identity. Friend-requests ride the existing **invite-redemption** flow (the
    identified / one-time channel). **Honesty on scope:** this removes the
    *explicit, logged* sender field (strong vs casual logging, log subpoena, a
    passive/honest-but-curious relay) but is only **partial** against an
    *actively-correlating* relay — the sender's device uses the **same IP** for its
    authenticated fetch session and its sealed send, so A→B can still be inferred by
    IP. True sender-anonymity would need network-layer decoupling (Tor/mixnet) —
    out of scope. This is the same **IP-correlation** property carried from D4b.
  - **Anti-abuse / blocking (falls out of the friend model — no server-side block
    list needed).**
    - **1:1 block = unfriend → delivery-token revocation.** Unfriending revokes
      that person's token via **profile-key rotation** (re-issue to remaining
      friends), so the relay stops accepting their sealed DMs to you; the
      **invite-only model prevents re-contact** — a blocked user cannot re-add
      themselves, only a *new* invite you'd never issue could. (Deleting an invite
      code only cancels a *pending, unredeemed* invite; it does **not** sever an
      existing friendship.)
    - **In-group block** (a non-friend in a friends-of-friends group) **=
      client-side hide.** Fan-out delivers group messages to all members, so a
      blocked member's messages are simply **not displayed** on your device — no
      relay-side per-member group filtering (keeps the relay dumb).
    - **Rate-limiting = IP-based DoS protection** (identity-free): caps volumetric
      abuse (dozens/sec, hundreds/min) from a single source to protect the relay,
      **no sender handle needed**. App-level per-sender spam isn't a server concern
      here — a flooding *friend* is handled by block/unfriend, and there is no
      stranger-reach surface to spam (invite-only friendship).
  - **Delivery-token mechanics (decided — write into
    [`accounts-and-crypto.md`](accounts-and-crypto.md) at build).** The existing
    **profile key** (protects the E2E profile/display-name) is the **access root**:
    a **delivery token = `KDF(profile_key, "delivery")`**. The recipient registers a
    **verifier** (hash of the token) with the relay; a sender presents the **token**
    and the relay checks `hash(token) == verifier` → authorizes delivery **without
    learning the sender**. The sealed envelope carries the sender's **signed
    identity certificate inside the ciphertext** (verified against the D5
    directory/transparency log on decrypt) — recipient learns the sender, relay
    never does. New-friend bootstrap uses the **invite-redemption** channel (D4b),
    not a token. Groups use an analogous **group delivery token**.
    - **Token granularity: shared profile-key token (decided).** One verifier per
      recipient — the relay never learns your **friend count**. Cost: **block/
      unfriend rotates the profile key and re-issues to all remaining friends**
      (O(friends) sealed messages; Signal's model) — accepted for the cleaner
      metadata, since blocks are rare and friend counts modest. (Group-member
      removal rotates the group token similarly.)
  - **Attachment / media transfer (decided).** Each attachment gets a fresh
    **random per-file key**; only the **ciphertext blob** leaves the device, while
    the **per-file key + metadata** (name, size, mime, content hash) ride *inside*
    the E2E message/note (under the conversation/note key) — never to the relay.
    The relay has a **transient blob store** (same hold-until-ack, zero-at-rest
    posture as the mailbox): sender uploads ciphertext → blob id; recipients fetch
    by id with a delivery token; deleted on ack or TTL. **Chunked + resumable**
    up/downloads; integrity via the content hash. An **inline encrypted thumbnail**
    (few KB) gives instant image/video preview; the full blob is fetched on demand.
    Received media persists to the **on-device encrypted store** (D2). **Tunables:
    100 MB/file cap** (relay-configurable), **undelivered blob TTL 14 days** (then
    dropped → "attachment expired, re-request from sender").
  - **Compression on send (decided).** **Images: keep the existing WebP pipeline**
    (`imageOptimize.ts` — resize to a max dimension + WebP re-encode @~0.82, on by
    default via `privacy.ts`; also the WebP poster/first-frame capture in
    `attachments.ts`). **New — video transcode → 720p30** (capped bitrate) *before*
    encryption, so sender *and* recipients store the smaller version (client-side
    via bundled ffmpeg in the native shell). Both **default-on**, with an **opt-out
    "send at original quality"** per file.
  - **Local retention / storage management (decided).** **Local, per-device** space
    reclamation — **distinct from D11 delete-for-everyone** (which tombstones
    globally); this deletes on *your device only* and affects no one else. A
    **Storage** screen shows space used per conversation (media vs messages). An
    **opt-in retention policy (off by default** — never silently delete user data**)**
    offers three modes: **(a) downscale old media** (> X days → ~360p / reduced
    image dims, still viewable); **(b) evict old media, keep messages** (drop blobs
    > X days, text stays, media shows a re-download placeholder); **(c) evict
    everything > X days** (messages + media). Plus manual "clear this conversation's
    media / clear all". Because every device is a full replica, local eviction sets
    a **per-device "evicted" watermark** so sync **won't re-download** pruned
    content; evicted media is **re-hydratable on demand** if still available (another
    of your devices, or the sender within TTL) — gone everywhere ⇒ shows "expired".
    Pairs with the D8 export (back up before pruning).
  *Status: decided — sealed-sender in v8; attachment transfer + on-send compression
  + local retention policy all specified.*

**D7 — Connectivity, voice & push. Decided.**
  - **Voice unchanged:** the relay keeps **STUN/TURN** + the mediasoup **SFU**
    (already required; voice has no at-rest data).
  - **Push = content-free, one abstraction.** Because content is E2E, the push is
    only a **wake-and-sync** signal; the relay stores per-device push tokens and
    fans a content-free ping across **web-push/VAPID (desktop/web) + APNs (iOS) +
    FCM (Android)** behind a single interface.
  - **Background sync:** **push-wake + foreground** (+ limited OS background
    refresh), **not continuous** — which is why the D6 mailbox holds until ack.
  - **Rich notifications via a Notification Service Extension (iOS) / background
    handler (Android).** The content-free push wakes the extension, which
    **fetches the queued ciphertext from the relay and decrypts on-device** — so
    the relay never sees content (works unchanged under **sealed-sender**). The
    NSE runs with **no biometric prompt**, so decryption needs a key readable while
    the app/vault is locked; to bound that, use a **dedicated "preview key"** (not
    the MK or content keys): the sender additionally encrypts a **small preview
    blob** (name + snippet) to it and the NSE decrypts **only that** — so a
    compromised/extracted preview key exposes **future previews only**, never
    history or full content. On failure (locked + unavailable key, timeout, or
    fresh boot) it **falls back to a generic notification** (generic is always the
    floor).
  - **Notification-privacy toggle (a real security control, not cosmetic)** — the
    setting picks the preview key's **keychain protection class**:
    1. **Rich always** *(default)* → **AfterFirstUnlock** — lock-screen previews
       after first boot-unlock; preview key extractable by forensic tooling while
       locked, but scoped to previews only.
    2. **Rich only when unlocked** → **WhenUnlocked** — generic on the lock screen,
       rich once unlocked; preview key never available while locked.
    3. **Generic** → no NSE decryption at all.
    Plus a **per-conversation override** (force generic for sensitive chats). Fresh
    boot (Before-First-Unlock) is always generic until the first unlock.
  - **Push credentials (decided) — no gateway in v8.** APNs/FCM sends require the
    app vendor's push keys (an APNs `.p8` auth key / an FCM service-account key —
    deployment secrets generated in the developer account, **not** App Store
    login credentials). The **first-party relay holds them directly** (gitignored
    `.env`, exactly like the existing integration keys) and pushes itself — the
    vendor and the relay operator are the same party at launch, so **no new
    infrastructure**. Keys are **never embedded in the public source or
    binaries** (trivially extractable → anyone could push-spoof/spam as the app
    and get the key revoked). A vendor-run **push gateway for third-party
    self-hosted relays** (Matrix/Sygnal-style: stateless, forwards content-free
    pings, sees only {push token, timing, relay IP}) is **post-v8**; until then a
    third-party relay has web-push only — **no timely mobile wake** (iOS gives no
    reliable background wake without APNs; Android Doze kills sockets without
    FCM). **Per-operator push keys are not possible:** APNs/FCM credentials are
    bound to the *app* (its bundle id / Firebase project), not to the server —
    only the app publisher's developer account can mint keys that push to the
    app, so a relay operator can't obtain their own (short of forking and
    distributing their own app under their own bundle id + store account, which
    breaks the single signed/reproducible build, D12). This app-binding is
    exactly why Matrix ended up with Sygnal. Partial exception — **Android via
    UnifiedPush**: once the app supports it, an operator (or user) can self-host
    a distributor (e.g. ntfy) — no Google, no gateway; **iOS has no equivalent**
    (even ntfy's iOS delivery rides a central APNs gateway).
  *Status: decided.*

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
    the recovery code restores *identity*, not *history*. **This is a deliberate
    regression from v2's shipped encrypted *server* backups** — v8 trades that
    server-side safety net away for the zero-at-rest posture, so losing every
    device now loses history in a way it doesn't today. Mitigations to weigh: a
    soft requirement of ≥2 devices, and/or an **optional, user-initiated, local
    encrypted export file** the user stores wherever they like (explicitly **not**
    server-side).
  - **Decided — both mitigations:**
    - **(a) Soft ≥2-device nudge.** Onboarding **encourages** adding a second
      device (phone + desktop) so single-device loss isn't catastrophic —
      **not enforced**, just prompted.
    - **(b) Optional offline encrypted export.** A **user-initiated** backup
      *file*, encrypted under the **recovery code / a passphrase**, that the user
      stores wherever they like (USB, their own cloud) — **never server-side**, so
      zero-at-rest holds. Restorable on a fresh device (recovery code now restores
      *history too*, if the user made an export). This is the genuine safety net
      for a single-device user or a total-loss event; it's a point-in-time
      snapshot (re-sync deltas from other devices/relays afterward if any exist).
  *Status: decided — ≥2-device nudge + optional user-controlled offline encrypted
  export; no server-side backup either way.*

**D9 — Conflict model (CRDTs).** Adopt **Yjs** for mutable synced state. It has an
official **CodeMirror 6 binding (`y-codemirror.next`)** — the app already uses
CodeMirror 6 — and Yjs is transport-agnostic, so we encrypt its **binary update
blobs** under the relevant key and relay them opaquely (proven pattern; Matrix
relays E2EE Yjs this way). **Decided — Yjs**, for the official `y-codemirror.next` binding (the app is CM6),
large-text performance, ecosystem, and the Matrix-proven E2EE-over-relay pattern.
**Local persistence via a SQLite/SQLCipher adapter** (through the Tauri Rust core —
*not* `y-indexeddb`, since D2 dropped IndexedDB for the native store); encrypted
binary updates relayed opaquely (per-note key for shared notes, per-conversation
key for mutable chat state). Concurrent offline edits **merge deterministically,
conflict-free**. Caveat to document: CRDT convergence is *conflict-free*, not
*semantically perfect* — two people editing the same sentence offline merge into a
deterministic but possibly awkward result; acceptable for notes. *Status: decided
— Yjs. Which state is CRDT vs last-writer-wins is settled per-surface in D10/D11.*

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
  - **Version history (decided):** re-expressed over Yjs as **coalesced
    auto-snapshots (~10 min, mirroring today's cadence) + user-created named
    versions kept indefinitely**, with a **generous retention cap** on
    auto-snapshots (storage is disk-bounded now, not the old 50-max quota) and
    update-log compaction beyond the window; restore via the existing History
    dialog. **Sync scope: fully synced, including co-editors** — a shared note
    carries a **shared revision timeline** visible to all participants (richest
    collaborative history; note content syncs via CRDT regardless — this governs
    past revisions). **Consent requirement:** the **share flow must inform the user
    that sharing a note also shares its full version history** (so a private edit
    timeline isn't disclosed unknowingly). *(Note content is never at risk either
    way — the converged state always syncs across devices + co-editors per
    D4c/D8; this only concerns who holds past revisions.)*
  - **Offline + auth:** **yes — notes work fully offline.** Unlock is local (D3/D4)
    and the store is local; the network is only needed to *share* changes with
    others or sync a new device.
  - **Migration (decided approach):** on first native-app run, authenticate →
    download existing server-stored encrypted notes → decrypt locally → seed each
    as a Yjs doc in the SQLCipher store; **best-effort import of the legacy server
    snapshots as read-only "legacy versions"**; then server storage is
    decommissioned for that user. One-time.
  *Status: decided — synced version history (with share-time disclosure);
  migration seeds current state + best-effort legacy-snapshot import.*

**D11 — Chat implications.** Append-only **messages are immutable** → simple
device replication (no CRDT needed). History becomes a **local log**
(Skype-style). Groups still need the relay for fan-out + offline queueing.
**Messages carry a relay-independent id** (sender-assigned unique id) so the same
message can be sent/deduped across multiple relays — required by **D4c** multipath.

**Ordering (decided) — relay arrival timestamp replaces server-assigned `seq`.**
Today the server assigns a dense per-conversation `seq` (`MAX(seq)+1` in a DB
transaction) and replies/edits/read-state all anchor on it; a zero-at-rest relay
can't own a durable counter, and D4c multipath means no single relay even sees
every message. The v8 model:
  - **Sort key = `(relayTimestamp, senderId, messageId)`.** The relay stamps each
    message at arrival (stateless — no counter to persist); the tuple tiebreak
    makes same-millisecond collisions deterministic.
  - **No dense integer `seq` is ever derived.** Devices hold different subsets of
    a conversation (history floors, D6 local eviction, mid-history pairing), so
    any local "sort and number" diverges across devices. Positions are never
    materialized — only the sort key.
  - **Anchors are message ids, not positions.** Replies, edits, and reactions
    reference the sender-assigned message id; `ReplyRef` keeps embedding a
    snapshot `{id, timestamp, sender, preview}` so every client renders the same
    anchor even if the original is missing/evicted. **Read state = max
    `(timestamp, id)` seen** — still a monotonic max register (overlay above).
  - **Multipath mixes relay clocks — tolerated.** Under D4c failover one thread
    can carry stamps from two relays with clock skew; fine for display order
    (seconds, not hours), and duplicates sent down both paths dedupe by message
    id. Nothing may assume one global clock.
  - **Threat-model note:** the relay is trusted for *order* (it could reorder or
    backdate stamps). Low impact — content is authenticated, replies snapshot
    their context, and a relay can already withhold/delay delivery — but it
    belongs in [security.md](security.md) when built.
  - Offline-composed sends are stamped at upload (a batch lands at upload time,
    not compose time — Signal behaves the same); local echo orders provisionally
    until the ack returns the stamp.

**Member-served history backfill — integrity (decided).** In local-first, a new
joiner's history (per the inviter's share-history choice) is served from
*members'* devices, so backfill must be tamper-evident: every message is
**individually signed by its sender's identity key** over `{message id,
conversation, content}` inside the E2E envelope — this extends D6's sealed
sender *certificate* (which proves identity) to also sign the *content*. A
member serving history can therefore never forge or alter what someone else
said; the joiner verifies each signature against the D5 directory/transparency
log. Residual (documented): a serving member can **omit** messages (selective
history) — not fully preventable; mitigated by preferring the owner's / multiple
devices as backfill sources. The relay arrival timestamp sits outside the
signature (it's assigned post-send), so backfill *order* is only as trustworthy
as the relay stamp — same trusted-for-order note as above.

**Mutable-state mapping (decided).** The append-only message log stays outside
Yjs (plain SQLite by `seq`); **mutable overlays live in a per-conversation Yjs
doc**, encrypted + relayed opaquely:
  - **Edits → LWW register** (single-author — only the author edits their own
    message, so last-write-by-logical-clock wins; a full text-CRDT would be
    overkill).
  - **Reactions → add-wins CRDT set** (the one place genuine multi-user concurrency
    happens, so set-CRDT semantics earn their keep).
  - **Read state → monotonic max register** ("last read `seq`" only moves forward;
    merge = take the max; no real conflict).
  - **Deletion → delete-for-everyone only** (there is **no "delete for me"**),
    implemented via a **propagating tombstone** (delete-wins): the marker replicates
    to all participants/devices, each removes the content, and the content is
    **garbage-collected after convergence** (the tombstone is what makes the delete
    reliably stick despite offline replicas — otherwise the message resurrects on
    re-sync). Renders as a **"message deleted" placeholder**. (Author deletes their
    own message; group-moderation deletion is a possible later extension.)
  - **Typing / presence → ephemeral** — transient signaling, not persisted, not
    CRDT.
  *Status: decided.*

**D12 — Trust / distribution (improved by going native). Decided.** A **signed,
store-distributed native app** plus **reproducible builds** is the strongest
answer to the served-code problem — strictly better than the web delivery an
earlier web-first draft worried about; **adopted** (store signing/notarization +
a reproducible-build pipeline so anyone can verify the shipped binary matches
public source). **Web client: kept as an explicitly-labeled, lower-trust
"linked-satellite" client** (WhatsApp-web-style), gated behind an **upfront trust
caveat** (its E2E crypto runs in **server-delivered JS** — the served-code surface
the native app escapes). Decided shape:
  - **Satellite-only** — the web client is **QR-linked from an existing native
    device** and **never holds durable identity** (a brand-new user installs
    native first; web can't be your sole device). Keeps identity/master key **out
    of served JS**.
  - **In-memory only** — no browser persistence (the use case is a possibly-shared/
    borrowed machine); nothing survives tab close. **Can:** live chat send/receive,
    fetch **recent** history on demand, view/edit notes online (in-memory CRDT),
    **join voice** (live, no at-rest data). **Cannot:** hold full offline history,
    be a full replica, or run backup export/restore. **Recent history is served
    by a linked native device over the relay (WhatsApp-Web model, decided)** —
    the relay stores nothing, so the satellite can only show history while a
    linked device is online to serve it.
  - **Session TTL** — **session-scoped by default** (ends on tab close), opt-in
    "keep me linked up to N days" for a trusted machine, and **always remotely
    unlinkable** from the native device's device list.
  - **Migration of today's users → native: NONE — greenfield launch (REVISED).**
    The original plan was a per-user data migration (install native → sign in with
    existing credentials → automatic first-run pull of server-stored data → old-key-
    signs-new-key attestation so contacts auto-trust the new identity → purge). With
    only a handful of users (me + 3 friends), that whole machinery isn't worth it.
    **New plan: no account migration.** v8 ships greenfield — deploy the v8 relay +
    akd-sidecar, everyone installs the native app and **creates a fresh v8 account**,
    then re-adds each other via the built invite flow (SAS-verifiable). This drops
    the identity-attestation crypto, the data-pull, the T-0 migration sign-in, the
    T+60 purge/straggler exports, and the rollback-to-legacy posture entirely.
    **⚠ PRE-LAUNCH ITEM — tell everyone to save their notes.** The cutover **wipes
    everything** (fresh accounts, no data carried over). Before flipping to v8, send
    all users a reminder to **export/save any notes they want to keep** — chat
    history is disposable; notes are not automatically preserved. (`migrate.ts` +
    the migration IPCs/`MigrationPrompt` become dead code → shelve/delete.)
  *Status: REVISED — greenfield launch, no migration (was: hard cutover with
  per-user migration). Native (full, signed, reproducible) + web (lower-trust,
  satellite-only). Pre-launch: warn users to save notes; everything is wiped.*
  - **POST-LAUNCH — codebase cleanup & review pass.** After v8 ships, do a
    dedicated sweep to remove anything unused/unnecessary that the pre-v8 →
    greenfield transition left behind: the store-level legacy-import methods
    (`import_notes`/`import_note_versions`/`import_conversations`/
    `import_contacts` — now test-only after the migration commands were removed),
    any legacy server/chat/crypto paths no longer reached once standalone web is
    disabled, dead types, and stale spec sections. (The top-layer migration code —
    `migrate.ts`, `MigrationPrompt.vue`, the migration IPC commands, and
    `spec/migration.md` — was already deleted when the greenfield decision landed.)
  - **Distribution & signing — phased, unsigned-first (DECIDED).** For the
    initial 4-user testing, ship **unsigned / free** and accept the friction; buy
    signing identities only when going wider. Recall: on **desktop** signing only
    removes scary warnings (you can run unsigned); on **mobile** signing is
    **mandatory to install at all**. Key fact: **one Apple Developer Program
    ($99/yr) covers both macOS notarization *and* iOS.** Phasing:
    - **Phase 1 — local testing, all unsigned/free:**
      - **Android — sideload over USB-C (primary quick-test path).** Build the
        Tauri Android target; a **debug build is auto-signed with a free debug
        key** (a release build uses your own free `keytool` keystore — either
        installs). Push it to the phone via **`adb install app.apk`** over the
        USB-C cable, or copy the APK across and tap it with **"install unknown
        apps"** enabled. No Play Store, no CA, no cost. ⚠ If you use a release
        keystore, **keep it safe** — updates must be signed with the same key or
        friends have to reinstall.
      - **macOS — unsigned, accept Gatekeeper.** First launch: **right-click →
        Open** (or System Settings → Privacy → "Open Anyway", or
        `xattr -dr com.apple.quarantine App.app`). Free.
      - **Windows — unsigned, accept SmartScreen** ("More info → Run anyway").
        Free.
      - **Linux — unsigned AppImage/.deb**, run directly. Free.
    - **Phase 2 — desktop signing (only when going past the friend group):**
      macOS notarization (Apple Dev $99), Windows **Azure Trusted Signing**
      (~$10/mo) or an OV/EV cert, Linux GPG signature + SHA-256 checksums.
    - **Phase 3 — iOS LAST (paid; can't be done free for a group).** Once
      everything else works unsigned, buy the **Apple Developer Program ($99/yr,
      also unlocks macOS notarization)** and test iOS then. iOS **must** be signed
      even to install on a device — a free Apple ID only yields **7-day
      self-signed dev builds for *your own* device via Xcode**, not viable for
      friends — so distribute via **Ad Hoc** (register each friend's device UDID,
      ≤100/yr) or **TestFlight**.
    - *Note: the Tauri **mobile shell (iOS + Android) isn't built yet** — it's
      still to-do (mobile init + the APNs/FCM push path land with it). This plan
      applies once mobile targets exist; **launch is desktop-first**, so all
      iOS/Android signing can be deferred until mobile is on the table.*

#### Key hierarchy, revocation & groups

**D13 — Key hierarchy (decided).** One derivation tree for every key v8
introduces or keeps. The load-bearing split is **derived** (re-derivable from
the seed; *cannot* rotate without rotating the seed) vs **random-and-wrapped**
(independently rotatable) — anything that must rotate on revocation is random.
(Write the as-built version into
[`accounts-and-crypto.md`](accounts-and-crypto.md) at build.)

```
MK / master seed (random, per user — every full device holds it)
│
│  at-rest wrappings (ways to open the vault):
│    ← OS-keychain vault key (biometric-gated; per device)      [D3]
│    ← Argon2id(password)                                        [portable fallback]
│    ← KDF(recovery code)                                        [cold start]
│
├─ DERIVED (deterministic, domain-separated KDF):
│    └─ per-relay identity keypair  = KDF(MK, "relay-id" ‖ relay-fp)   [D4b]
│
└─ RANDOM, wrapped under MK (rotatable):
     ├─ profile key                 rotates on: unfriend (the "block" action, D6),
     │   │                                      device revocation
     │   └─ delivery token = KDF(profile key, "delivery") → hash → relay verifier
     ├─ per-conversation epoch keys rotates on: membership change, device revocation
     ├─ per-note keys               rotates on: share revocation, device revocation
     └─ preview key (also sealed to contacts; keychain class per D7 toggle)

Per-device (random, OS keychain, never leaves the device):
     ├─ device keypair — signs relay challenges → short-lived token (D4);
     │                    pairing target for sealed MK (D8)
     └─ SQLCipher key — local DB at rest (D2)

Standalone:
     ├─ per-file attachment keys (random per file, carried inside the E2E message)
     └─ backup export key = KDF(recovery code / passphrase, "backup") (D8)
```

  - Terminology: **"block" is not a separate mechanism** — 1:1 block = unfriend →
    profile-key rotation → delivery-token revocation, and in-group block is a
    client-side hide (both per D6). The tree's rotation triggers say "unfriend"
    accordingly.

**D13a — Device revocation: two named tiers (decided).** So the UI and docs
never oversell what revocation covers:
  - **Tier 1 — "revoke lost device"** (the realistic case: lost/stolen but
    locked; keychain + SQLCipher intact). Stop honoring the device's token
    refresh (D4 — its relay access dies within the token window) **and rotate
    everything it could decrypt**: profile key (+ re-issue delivery tokens to
    all friends), every conversation/group epoch key it was in, every
    shared-note key, and the preview key — O(friends + conversations + shared
    notes) sealed messages, the same machinery as unfriend/member-removal
    applied everywhere at once. Past content is compromised regardless (the
    device held plaintext) — the same documented boundary as v5 revocation.
  - **Tier 2 — "identity compromise"** (device known compromised while
    *unlocked*). The attacker holds the master seed itself, so they can
    re-derive the per-relay identity keys — the one thing rotation can't fix —
    and could even sign a fraudulent "key rotation" attestation. Recovery =
    **new seed / new identity, re-verified with contacts out-of-band (SAS)**.
    Tier 1 must never be presented as covering this case.

**D14 — Group authority (decided).** Who enforces
membership/roles with no authoritative server. **Signal's answer (GroupsV2):**
the member list + roles live **encrypted on Signal's servers** behind zkgroup
anonymous credentials — server-authoritative but blind. The full zk machinery
buys us nothing, though: our relay **already learns group membership from
fan-out queues** (D6 copies into each member's queue), and the zero-at-rest
posture is about **content and media** (the legal/operational honeypot), not
small membership metadata. **Leaning: a relay-held, signed group-state
record** — the relay stores the current membership + roles document (it needs
the member list to fan out anyway), versioned against rollback, and accepts an
update only if signed by the owner/an admin; members verify the same signatures
client-side. This keeps v4's shipped **owner/admin roles** viable (no demotion
on migration), resolves offline admin races by relay ordering, and stores no
content. Trade to note: the relay learns *which admin* performed each
membership change (it must verify the signature). **Roles: owner + admins are
kept** (as shipped in v4 — no demotion on migration); owner-only was considered
and rejected (owner-offline would block all membership changes, and total owner
loss would freeze the group). *Status: decided — relay-held signed group-state
record, owner + admin roles.*

**D15 — Account escrow, cold-start recovery & the fate of passkeys (decided).**
Resolves a contradiction the consistency review caught: D3a promises a
**password cold-start on a fresh, unpaired device** and D8 promises "the
recovery code restores *identity*" — but with no other device, no backup file,
and a stateless relay, those secrets would have **nothing to decrypt** (the MK
is random; the per-relay identity keys derive from it).
  - **Decision — relay-held wrapped-MK escrow.** The relay stores the
    **password-wrapped and recovery-code-wrapped MK** (a few hundred bytes; the
    same blobs as the shipped v1 model), registered on **every relay the user
    joins** (identical ciphertext everywhere — redundancy, so a dead relay never
    loses the escrow). This is an explicit, deliberate carve-out: the
    zero-at-rest posture means zero **content** at rest — the relay already
    persists the directory, KT log, delivery verifiers, and push tokens; key
    blobs encrypted under secrets only the user holds are not the honeypot the
    posture exists to avoid.
  - **Why this is safe (the interception question).** **Argon2id runs
    client-side and the password never leaves the device** — already true in the
    shipped v1 model: the server stores only a *domain-separated auth-key hash*
    for login, which is useless for unwrapping (different HKDF domain). An
    honest-but-curious relay therefore never sees a password to intercept. The
    historical caveat was **served code** — a malicious server could ship JS
    that exfiltrates the password — and the **signed native app (D12) closes
    exactly that hole**. Residual risk: a malicious relay can mount an
    **offline brute-force against the password-wrapped blob** — mitigated by
    Argon2id (m≈19 MiB, t=2) + the enforced 16-char minimum; the
    recovery-code-wrapped blob (160-bit random) is computationally out of reach
    regardless.
  - **Passkeys are retained alongside the (mandatory) password.** Context:
    today passkeys are **PRF-only** — registration *rejects* non-PRF passkeys,
    because a passkey's sole job in v1 is wrapping MK via the PRF secret. Native
    shells make PRF unreliable (D1/D3), so v8 **re-scopes** passkeys instead of
    dropping them: (i) **bootstrap/recovery authentication** to a relay where
    the shell supports WebAuthn — a synced passkey (iCloud Keychain / Google
    Password Manager) makes fresh-device sign-in phishing-resistant and smooth,
    with the password auth-key as the universal fallback; (ii) **opportunistic
    PRF wrap** where PRF actually works (e.g. the D12 web satellite in real
    browsers) — never load-bearing; (iii) day-to-day relay auth remains the
    **device key** (D4) — passkeys are not involved. Registration stops
    rejecting non-PRF passkeys (the auth role doesn't need PRF). The
    **password is mandatory** (UI-3) because, absent reliable PRF, it is the
    only universal MK-decryption factor — the recovery code stays break-glass.
  *Status: decided.*

### Non-goals

- **Pure peer-to-peer / DHT.** Availability (offline delivery), groups, and NAT
  traversal all need a relay; a thin relay is kept deliberately.
- **Any durable server-side content store or server-side backup** — the whole
  point. (An *optional, user-controlled, offline* export is the only backup form
  on the table; see D8.)
- **Federation** across relays (groups spanning two relays) — cross-relay
  identity, key distribution, and message relay are out of scope (this was the
  multi-server plan's exclusion, carried forward).

### Suggested phasing (large rework)

1. **Native shells** (desktop + mobile) wrapping the existing app; move durable
   storage to local SQLite (D1, D2); import existing server data on first run;
   stand up **code-signing + reproducible builds** (D12).
2. **Local offline unlock** — OS keychain / biometric / password, decoupled from
   server auth (D3, D4).
3. **Minimal relay** — strip durable storage down to the encrypted mailbox +
   directory + push + STUN/TURN; **sealed-sender delivery-token gating +
   profile-key-rotation revocation + IP-based DoS rate-limiting** (D6, D7).
4. **CRDT sync** — Yjs for notes + mutable state, encrypted-blob relay, offline
   merge (D9, D10, D11).
5. **Multi-device** — QR pairing + device-to-device history transfer, no server
   backup; ≥2-device nudge + optional offline encrypted export (D8);
   **cross-relay contact continuity** — E2E same-me attestations, multipath
   failover routing + dedup, contact-link UI (D4c).
6. **Key verification** (D5) — per-relay key-transparency log (AKD/CONIKS-style)
   as the automatic default **plus** SAS fingerprint verification as the
   server-trust-free anchor; **both in v8**.

### Implementation status (v8 branch)

Design decisions closed (D1–D15, UI-1–5) and the core is **built on the v8
branch**: the Tauri Rust-core + SQLCipher local store (D1/D2), key hierarchy +
escrow/restore (D13/D15), the full relay surface (auth/directory/KT, sealed
mailbox + live delivery, DM + group blobs, group state — D4/D5/D6/D11/D14), the
friend invite→mutual-friend handshake (D4b), and **complete DM + group messaging
with full parity** (send/edit/delete/react/unread/live) behind a native chat UI.
**Remaining:** attachments-in-messages (blob store is built, unwired), blob
chunked/resumable transfer, voice under v8 (D7 device-token auth), content-free
push (D7), KT inclusion proofs/auditor (phase 6), and the legacy→v8 cutover
(D12). Running detail: `LOCAL-FIRST-LOG.md`.

### Remaining pre-implementation spec work

The design decisions are closed (D1–D15, UI-1–5). **All items below are now
drafted** — each links to its spec; what remains at build time is finalizing
exact payload/table shapes and folding the relay state inventory into the
[security.md](security.md) threat model:

- **Relay wire/API spec + relay state inventory** — **drafted: see
  [relay.md](relay.md)** (endpoints, auth, mailbox/blob mechanics, the complete
  durable/transient/never-stored inventory). Remaining: fold the state
  inventory into the [security.md](security.md) threat model at build.
  (Feeds phase 3.)
- **Group authority (D14)** — **drafted:** signed group-state record endpoints +
  anti-rollback in [relay.md](relay.md) § Group state; fine-grained role rules
  at build. (Phase 3/4.)
- **Local SQLite schema + Rust/webview boundary** — **drafted:
  [local-store.md](local-store.md)** (schema sketch, domain-level IPC command
  surface, headless-client architecture; keys live in the Rust core and never
  cross IPC). (Phase 1.)
- **Friends-surface changes** — **drafted:** [chat.md](chat.md) § "v8 — friends
  & invites" (invite-only supersedes request-by-handle; enforcement moves to
  delivery-token capabilities). CLAUDE.md invariant wording updates at cutover.
  (Phase 3.)
- **Migration runbook** — **drafted: [migration.md](migration.md)** (bootstrap
  sign-in, pull-everything scope, old-key→new-key attestation, T+60 purge,
  straggler export, rollback posture). (Phases 1/6.)
- **Backup export format** — **drafted:** [local-store.md](local-store.md)
  § Backup export format (versioned encrypted container, media toggle,
  point-in-time restore + delta-sync). (Phase 5.)
- **KT log format + reference-auditor scope** — **drafted:
  [key-transparency.md](key-transparency.md)** (the publishable D5 spec).
  (Phase 6.)
- **Voice under v8** — **drafted:** [voice.md](voice.md) § "v8 changes"
  (device-token auth; multipath ring, dedup by call id; media on the relay
  that carried the accepted offer). (Phase 3.)
- **v8 test strategy** — **drafted:** [testing.md](testing.md) § "v8 additions"
  (layers F–K: Rust-core units, sync simulation, CRDT convergence properties,
  relay integration, auditor, native e2e). (Phase 1.)
- **Protocol/version compatibility** — **drafted:** [relay.md](relay.md)
  § Envelope versioning + [local-store.md](local-store.md) § Versioning
  (never-drop-data policy; buffer + "update the app"). (Phase 4.)
- **Desktop distribution channels (deferred — decide after implementation,
  before shipping).** Store vs direct-download + Tauri updater per OS (the
  updater signing key is security-critical — a compromise is the served-code
  problem reborn).
- **Media-codec licensing (decided): LGPL ffmpeg, no GPL components.** The
  bundled ffmpeg (D6 video transcode) is an **LGPL-only build** — no libx264 —
  because ffmpeg's *hardware-encoder wrappers* are themselves LGPL: the actual
  encoding runs in the OS/silicon, whose patent licensing is the platform
  vendor's problem. Per platform: **`h264_videotoolbox`** (macOS/iOS),
  **`h264_mf`** (Windows Media Foundation), **`h264_mediacodec`** (Android),
  **`h264_vaapi`** where present on Linux, with **openh264** (BSD-licensed
  wrapper; Cisco's prebuilt binary carries their H.264 patent grant when
  downloaded from Cisco at install time — the Firefox model) as the
  Linux/software fallback. Output stays **H.264 + AAC in MP4 @720p30** —
  universally playable in every platform webview, unlike VP9/AV1 (spotty iOS
  support). LGPL obligations: **dynamically link** ffmpeg, ship the license
  notices, point to (or mirror) ffmpeg's source, and share any modifications
  *to ffmpeg itself* — the app's own license is unaffected. Decode/demux/mux
  for the transcode pipeline is ffmpeg-core (LGPL-fine; H.264 *decoding* never
  needed libx264).
- **App source license (decided): AGPL-3.0-only.** `LICENSE` added at the repo
  root; `license` set in every `package.json`; README states the terms.
  Self-hosters stay free; anyone offering a modified version as a network
  service must publish their changes; as sole copyright holder the author can
  still dual-license their own code for app-store distribution. Ads / Patreon /
  paid hosting remain fully compatible (the license restricts licensing terms,
  not monetization). Also underpins D12's "reproducible builds anyone can
  verify against public source."

### Open questions

- **Framework:** **decided — Tauri v2** (one stack, all five platforms, light
  binaries); the Linux WebKit editor-render check **passed** (caret parity +
  equivalent rendering vs Chromium). **Capacitor + Electron** stays the documented
  fallback if a later blocker appears (D1).
- **Mobile push (D7): decided** — content-free push across web-push/APNs/FCM behind
  one abstraction; push-wake + foreground sync; rich notifications via NSE/
  background handler decrypting a **dedicated preview key** on-device; **3-level
  notification-privacy toggle** (Rich always [default, AFU] / Rich-when-unlocked
  [WhenUnlocked] / Generic) + per-conversation override.
- **Single-device data-loss (D8): decided** — **both** a soft ≥2-device onboarding
  nudge **and** an optional user-controlled **offline** encrypted backup export
  (under the recovery code, user-stored, never server-side).
- **Web client (D12): decided** — kept as an **opt-in, explicitly-labeled
  lower-trust linked client** (reduced/online-only), alongside signed +
  reproducible-build native apps as the primary, full-capability tier.
- **Desktop passkeys:** **decided — OS-keychain + biometric + password** for
  local unlock; PRF optional/never load-bearing. Passwordless cold-start on a
  fresh unpaired device is **not** a requirement (D3/D3a), so no need for robust
  cross-platform PRF native modules.
- **Key transparency (D5): decided** — per-relay AKD/CONIKS-style transparency
  log **plus** SAS fingerprint verification, **both in v8**. Open sub-thread to
  track: maturity of the **auditing/gossip ecosystem** the log's split-view
  detection relies on.
- **Multi-relay auth:** device-key challenge/token protocol **decided** (nonce +
  relay-id in signed payload); invite-code format **decided** (self-describing,
  app-only redemption, two carriers); still open whether an opt-in global
  directory should later enable same-handle-across-servers UX without re-linking
  per-relay identities (D4b).
- **Cross-relay contact continuity (D4c):** persistent multipath redundancy —
  **decided, full v8 scope** (failover routing + cross-path dedup + contact-link
  UI all in v8).
- **Message ordering (D11): decided** — relay arrival timestamp; sort key
  `(relayTs, senderId, messageId)`; anchors by message id; **no dense `seq` is
  ever derived**.
- **Key hierarchy & revocation (D13/D13a): decided** — derivation tree
  (derived = per-relay identity keys only; everything rotatable is
  random-and-wrapped) + two-tier revocation (lost-device rotation vs identity
  compromise).
- **Group authority (D14): decided** — relay-held **signed** group-state record
  (metadata-only at rest), owner + admin roles kept as shipped in v4.
- **Push for third-party relays: deferred post-v8** — the first-party relay
  holds the APNs/FCM keys directly (D7); a Sygnal-style vendor gateway comes
  later, when third-party relays exist.
- **Cold-start escrow & passkeys (D15): decided** — relay-held
  password/recovery-wrapped MK escrow (an explicit zero-*content*-at-rest
  carve-out); passkeys retained for bootstrap auth + opportunistic PRF (never
  load-bearing); the password is mandatory as the universal decrypt factor.
- **Release strategy: decided** — one release; all six phases land on this
  branch/PR; hard cutover on merge/ship.

### UI/UX design decisions

Foundational UI/UX choices (distinct from the "decisions" above and from the
surface-map below), worked through one at a time.

- **UI-1 — Multi-relay presentation: unified aggregate (decided).** Several
  connected relays appear as **one** friends list / chat inbox / notes space;
  **relays are background connectivity**, not separate worlds. A subtle **"via
  Relay X"** indicator appears only when relevant (e.g. on a contact's failover
  state). Relay management lives in **Settings**. Chosen to match **D4c** (one
  contact, reachable across relays, converging to a single thread) and the
  architecture's "aggregate in one UI"; rejected the Discord-style per-relay
  switcher (fights D4c, adds friction).
  - **Forced consequence — same-handle disambiguation.** Because each relay mints
    handles independently, `Alice#1234` on Relay A and Relay B may be **different
    people**. So **contacts are keyed on verified identity, not the handle string**:
    D4c-linked identities **merge into one entry**; unlinked same-handle contacts
    stay **distinct entries**, disambiguated by E2E display name / avatar /
    verification state, with a **relay tag surfaced whenever two entries would
    otherwise look identical**.

- **UI-2 — Navigation shell: keep the inherited responsive shell (decided).**
  Top-level stays **Notes · Chat · Friends · Settings** (as today), responsive
  desktop rail (`AppSidebar`) / mobile drawer-or-tabs (`AppDrawer`). **All new v8
  surfaces live under Settings** — **Relays, Devices, Verification, Notifications,
  Storage, Backup** — with contextual entry points elsewhere (e.g. verify from a
  contact, link a device from onboarding). No per-relay switcher (UI-1 is unified).
  Rejected promoting new destinations to top-level (heavier nav, diverges from
  today).

- **UI-3 — Onboarding / first-run / migration (decided).** A **single smart entry**
  (Welcome → *New* / *Existing*). **New user:** mint handle → **unlock setup with
  all factors front-loaded** (biometric primary + **mandatory password** +
  **recovery code shown & confirmed** — front-loaded because the recovery code is
  the cold-start path *and* the D8 backup-export key) → **prominent-but-skippable
  "add a second device" nudge** → in. **Existing user, new device:** the
  **highlighted primary path is "Pair with a device you have"** (QR + SAS → sealed
  MK + history stream, D8), with clearly-secondary fallbacks **"Use recovery code"**
  (warns: identity only, no history) and **"Import backup file"** (D8 export).
  **Web→native migrant (hard cutover):** *Sign in* → existing-credential bootstrap
  → **auto-migration progress** (pulls server data local, D10) → local unlock setup
  → in. Design intent: pairing is the emphasized restore path; unlock factors are
  front-loaded, not progressive.

- **UI-4 — Add someone / connect a relay (decided).**
  - **Add friend** (unified; per-relay under the hood): **"Add friend"** →
    *generate invite* (QR + copyable link + in-app share button, D4b); if on
    multiple relays, **pick which relay** (default = home relay). Or **"I have an
    invite"** → paste / scan / tap → in-app confirmation.
  - **Invite auto-joins an unknown relay:** redeeming an invite for a relay you're
    not on shows inline **"Join [relay] to connect with [name]?"** → joins (derives
    per-relay identity, claims handle) *then* adds the friend — no separate step.
  - **Manual relay add:** Settings → Relays → **Add relay** (HTTPS URL + invite).
  - **Relay naming:** a relay provides its **own self-declared name** (used in the
    "via [relay]" indicator, UI-1). On **joining**, a **welcome modal** offers to
    set a **local nickname** ("Bob's server") that overrides the display for that
    user; nickname is local-only.
  - **Default relay: deferred (not in v8 initially).** Architecture keeps room for
    **configurable first-party default relay(s)** that new users auto-join — *may be
    added later*. Until then a **brand-new user joins a relay during onboarding**
    (enter a URL or redeem an invite) to mint their handle; a default relay later
    would smooth this cold-start. *(Reconciles UI-3: the new-user path includes a
    "join a relay to get started" step while no default exists.)*

- **UI-5 — Contact surface: promote to a full contact page (decided).** Today the
  only per-contact UI is **`ProfileDialog.vue`** — a small modal showing
  avatar/display-name/bio, read-only. v8 adds surfaces with nowhere to live
  (verification/SAS, multipath reachability, block, shared notes + mutual groups,
  per-conversation notification override). Decision: **keep `ProfileDialog` as a
  quick-peek** (avatar · name · handle · verified badge · a "View full profile"
  entry) and add a **dedicated full contact page** holding the detail: **identity**
  (display name, per-relay handles) · **verification** (verified state, "Verify via
  SAS", key-change notices — hard alarms as a blocking banner) · **reachability**
  (D4c relays + failover, "link another relay") · **shared** (notes + mutual
  groups) · **notification override** (D7) · **Block** (= unfriend + revoke, D6).
  Chosen over cramming everything into the modal — more room for the new surfaces,
  at the cost of a new page to build.

### UI surface — how these decisions reach the user

Where each decision actually shows up on screen. Organized by user-facing area
(not by decision number); decisions are cross-referenced in **(Dx)**. Items marked
*open* are UI choices still to settle during design; everything else follows from a
locked decision. Existing UI invariants still hold — handle is the only identifier
(`Word#1234`), contacts overlay the E2E display name, friends-gate all 1:1 reach.

- **Install & first run (D1, D8, D12).** Per-platform **native app** downloads
  (Win/macOS/Linux via signed installers/stores; iOS/Android via App Store/Play);
  a "verify this build" affordance in **About** exposes the **reproducible-build**
  hash (D12). First run: create-or-restore identity, then either **restore from an
  existing device** (QR pairing, below) or start fresh; a **soft "add a second
  device" nudge** appears once set up (D8).

- **Unlock & lock (D3/D3a, D4).** A **lock screen** offering **biometric** (Face/
  Touch ID / platform equivalent) as primary, with **password (Argon2id)** as the
  always-available fallback and **recovery code** entry for cold-start on a fresh,
  unpaired device (D3a). **Settings → Security** carries the per-device re-lock
  toggle: *"Stay unlocked"* vs *"Require unlock when the device locks / after N min
  idle"* (D4). The relay token refreshes silently — never surfaced.

- **Friends, invites & relays (D4b, D4c, D5).**
  - **Add a friend** → generate a **self-describing invite** rendered three ways:
    an in-app **"add friend" button** (when shared through an existing Accord chat),
    a **copyable universal link**, and a **QR code**. Redeeming one opens an **in-app
    confirmation** (never a browser) (D4b).
  - **Relays** are managed in settings: **"Add a relay"** = paste its HTTPS URL +
    accept its invite; a **relay list** shows each connected relay and its status.
    Handles are per-relay; the UI never implies one identity spans relays (D4b).
  - **Contact detail** shows the relays a contact is **reachable via** ({Relay A,
    Relay B, …}) with a **"link across relays"** action and a subtle **failover
    indicator** ("via Relay B" when A is down) (D4c).
  - **Verification:** a **Verify** screen shows the **SAS words** to compare
    out-of-band, a **"verified" badge** on confirmed contacts, and automatic
    key-integrity warnings in **two tiers** (D5): **soft** — a *contact's key
    changed* (often a benign new device) shows a **non-blocking inline system
    message + "unverified again" badge**, cleared by re-doing SAS; **hard** — a
    *split-view / self-audit failure / inconsistent roots* (real relay-compromise
    signal from the gossip check) shows a **blocking full-screen alert that halts
    sending to affected contacts**, prompting SAS re-verify and offering to review/
    disconnect the relay.

- **Chat (D11, D6).** Message **edits** (pencil affordance, "edited" marker),
  **reactions** (emoji picker; concurrent reactions merge silently), **read
  receipts**, and **typing indicators**. **Delete** offers only
  **delete-for-everyone** (no "delete for me"); deleted messages render as a
  **"message deleted" placeholder** (D11). **Block** lives in the contact/message
  menu — for a friend it **unfriends + revokes reach**; for a non-friend in a shared
  group it **client-side hides** their messages (D6). Sealed-sender and
  rate-limiting are invisible.

- **Notes (D10, D9).** **Live collaborative editing** with remote **cursors/
  selections** in shared notes; offline edits **merge with no conflict dialog** on
  reconnect (D9). The **History dialog** lists auto-snapshots + named versions with
  **restore** (D10). The **Share dialog** must show the **consent disclosure** that
  *sharing this note also shares its full version history* (D10). A clear **offline
  indicator** shows edits are local until sync.

- **Notifications (D7).** **Settings → Notifications** exposes the **3-level
  privacy toggle** — *Rich always* (default) / *Rich only when unlocked* / *Generic*
  — plus a **per-conversation override** to force generic for sensitive chats.
  Notifications render rich (sender + preview, decrypted on-device) or generic per
  that setting; a first-run **push-permission** prompt gates the OS layer.

- **Multi-device & backup (D8, D4c).** **New-device pairing** flow: the new device
  shows a **QR**, the primary **scans** it, both confirm a **SAS**, then a **sync
  progress** view streams history device-to-device. **Settings → Backup** offers
  **"Export encrypted backup"** (a user-held file, encrypted under the recovery
  code) and **"Restore from backup"** (D8). Onboarding surfaces the **≥2-device
  nudge**.

- **Connection, sync & offline status (D4, D6, D9).** A persistent, unobtrusive
  **status affordance**: online/offline, which relays are connected, and
  **sync state** (syncing / up-to-date / queued-while-offline). Everything works
  offline; the UI makes "you're offline, changes will sync" legible rather than
  erroring.

- **The web client (D12).** A **lower-trust linked satellite**, gated behind an
  **upfront "limited / lower-trust" notice**. Entry is **"link this browser"** →
  scan a QR from a native device (no standalone web login). In-memory session: live
  chat, recent history on demand, online note view/edit, and voice; **no** full
  history / offline store / backup export (those controls absent or clearly
  disabled, with a "get the app" prompt). Session ends on tab close by default
  (opt-in keep-linked); the native device's **device list** can **remotely unlink**
  it. At v8 launch, **standalone web is disabled** (hard cutover) — today's
  web-first users **install native → sign in → auto-migrate** (D10), after which
  web works only as a satellite.

- **Attachments (flagged, see D6 open item).** Send/receive media UI exists today;
  the v8 change (on-device storage + relay-blob transfer, with size/chunking/resume
  still to specify) mostly affects **progress/failure/retry** states for large
  transfers — to be detailed alongside the attachment-transfer design.

## v9 — Public chats (post-v8)

Direction decided during the v8 design pass; **deliberately post-v8** — nothing
here is in the v8 rework's scope. This is the pseudo-Discord "public room"
story.

### Decided direction

- **A new, distinct chat type — and it is NOT E2E-encrypted.** E2EE in a room
  anyone with a link can join protects against nobody (any party — including a
  relay operator — can join pseudonymously and read), while costing O(members)
  rekey churn on every join/leave. Making public chats **plaintext-to-relay**
  eliminates rekey churn, lets the **relay itself store + serve public history**
  (which removes the member-served-backfill availability/tamper problem for this
  chat type entirely), enables **server-enforced admin controls** (kick, delete,
  slow-mode, …), and scales to large rooms. This is a **deliberate,
  explicitly-public carve-out from zero-at-rest** — that posture exists to avoid
  holding *private* content, which public-room content is not.
- **Link-joinable, not directory-listed.** A standing, **multi-use group invite
  link** (reuses the D4b invite machinery; grants room membership, not
  friendship). Directory-style discovery is out of scope (open question below).
- **Admission is manual.** A joiner waits until the **owner (or an admin) is
  online and admits them** — per-joiner approval, with an optional **"admit
  all"** switch for large influxes.
- **Sender signatures still required** even in plaintext rooms (same per-message
  identity signature as D11 backfill integrity), so neither the relay nor a
  member can forge or alter what someone else said.

### Open questions (punted from the v8 design pass — resolve when speccing v9)

- **Moderation & operator implications:** a relay hosting plaintext public
  content takes on real moderation duties (abuse/CSAM/DMCA exposure the
  zero-at-rest design deliberately avoided). Likely **opt-in per relay** — an
  operator chooses whether to enable public chats at all; needs its own
  [security.md](security.md) section.
- **Retention:** does public history live on the relay forever? Caps, pruning,
  owner-configurable retention?
- **Scale ceilings:** read receipts/typing must be suppressed or batched in
  large rooms (N members ⇒ ~N² receipt events per fully-read message); media in
  large rooms multiplies home-upload bandwidth (N × blob fetches per attachment)
  — thumbnail-first / lazy fetch helps, but may need caps.
- **Admin powers:** with plaintext rooms, message deletion / pinning / slow-mode
  become server-enforceable — how much of the Discord moderation surface to
  build, and does this pressure D14 toward keeping admin roles?
- **Identity exposure:** joining exposes your per-relay handle to strangers —
  read-only lurking? per-room display identity?
- **Friends-gate interaction:** public-room co-members are strangers — confirm
  co-membership implies **no** DM/share reach (invite-only still rules all 1:1),
  unlike friends-of-friends group co-membership today.
- **Discovery:** any directory/listing at all, or links only?

## v12 — Video streaming in voice channels?

Far future — not intended for a long time.

- What strain would this put on server-host hardware?
