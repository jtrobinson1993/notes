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

## v8 — Local-first across minimal relays: your data lives on your devices

**Status: long-term goal, large rework. Direction is chosen and **all design
decisions D1–D12 are now resolved** (each marked *decided* below; see also
"Open questions", all closed). **Nothing here is built yet** — the next step is
implementation per "Suggested phasing." This section captures the design digging
done *before* committing engineering.**

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
cross-platform PRF (broken on Linux desktop — D1) or a server-held wrapped key
(which would dent the zero-at-rest posture). The model is therefore: biometric/
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
  *Status: decided — transparency log + SAS both in v8.*

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
  - **Crypto-spec follow-on:** the delivery-token issuance + **profile-key
    rotation** revocation design must be written into
    [`accounts-and-crypto.md`](accounts-and-crypto.md) when built.
  *Status: decided — sealed-sender in v8 (delivery-token gating + profile-key
  rotation; IP-based DoS rate-limiting).*

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

**D11 — Chat implications.** Append-only **messages are immutable + ordered by
`seq`** → simple device replication (no CRDT needed). History becomes a **local
log** (Skype-style). Groups still need the relay for fan-out + offline queueing.
**Messages carry a relay-independent id** (sender-assigned logical id/clock, not
per-relay `seq`) so the same message can be sent/deduped across multiple relays —
required by **D4c** multipath.

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
public source). **Web client: kept as an explicitly-labeled, opt-in "lower-trust
linked client"** (WhatsApp-web-style) — reduced-capability + **online-only** (can't
hold full local history, per D2), gated behind an **upfront trust caveat** so users
knowingly accept that its E2E crypto runs in **server-delivered JS** (the
served-code surface the native app escapes). Two capability tiers to maintain, in
exchange for zero-install accessibility + an easier transition from today's
web-first app. *Status: decided — native (full, signed, reproducible) + web
(opt-in, flagged, reduced/online-only).*

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

## v12 — Video streaming in voice channels?

Far future — not intended for a long time.

- What strain would this put on server-host hardware?
