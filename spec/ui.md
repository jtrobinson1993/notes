# UI — theming & app shell

> **Scope.** Everything here describes the **native (Tauri) shell**, which is the
> only client. The legacy browser SPA's surfaces — Login / Setup / Recover /
> Invite pages, the admin Users & Invites screens, the PWA install prompt, the
> conversation view, the share and history dialogs, the image lightbox and the
> right-hand drawer — were deleted with it. They are not "hidden" or "web-only";
> they do not exist. A rebuilt browser client is future work
> ([roadmap.md](roadmap.md#d16--a-v8-web-client-deferred)).

## Themes (v2.2, shipped)

Two independent axes:

- **Light / dark / system** — toggles the `.dark` class + `color-scheme` and
  drives every Tailwind `dark:` variant.
- **Color palette** — `brand` (default), `pastel`, `high-contrast` — applied as a
  `data-theme` attribute on the root element.

Both are **device-local** (localStorage `notes:theme`, `notes:palette`), not
synced, and applied **pre-paint** by a small inline `<head>` script so dark /
high-contrast never flash white on load.

The same axes also drive the **`theme-color` meta**, so the webview's status-bar
chrome and the area **behind the notch** are painted the app's page background
rather than a fixed pair of light/dark values. (Only a mobile shell actually has
that chrome, and the mobile shell is unbuilt — see
[roadmap.md](roadmap.md#mobile-shell-ios--android) — but the mechanism is in
place and costs nothing on desktop.) It's a
single tag — a `media`-query pair can't express it, since the chosen mode can
differ from the OS preference and each palette has its own page colour. The
pre-paint script seeds it from a small mode×palette hex map; once running,
`lib/theme.ts` (`apply` → `syncThemeColor`) re-reads the **computed** body
background after each theme change so it stays correct for every palette without
duplicating the hexes (transparent values — before the stylesheet applies — are
skipped so the pre-paint value isn't clobbered).

### Palettes swap the token layer, not components

Each `data-theme` block redefines the `--brand-*` note colors **and the
Tailwind v4 neutral ramp** (`--color-zinc-*`). Because v4 compiles every neutral
utility to `var(--color-zinc-*)` (verified: ~86 references), overriding those
custom properties re-themes all surfaces app-wide **with zero component edits** —
the change lives entirely in `style.css`. Notes store only `var()` references, so
existing notes restyle for free.

- **brand** — Tailwind defaults.
- **high contrast** — `zinc-50`/`zinc-950` pinned to pure white/black, a strong
  grey ramp, vivid note colors.
- **pastel = Catppuccin** — Latte in light mode, Macchiato in dark (matching a
  catppuccin-macchiato terminal). The dark page background is Macchiato `crust`
  `#181926`; body text a brightened lavender-white `#d9e0f7`.

### Themed app controls & text

- **Accent:** the action accent (primary buttons, links, focus rings, selected
  state) is themed like the neutrals — each palette overrides the Tailwind
  `--color-blue-*` scale. The only blue in the app is accent/action (no semantic
  "info" blue), so a global override is safe. Brand keeps Tailwind blue; pastel
  uses Catppuccin blue (Latte `#1e66f5` button bg / light links, Macchiato
  `#8aadf4` dark links); high contrast a vivid deep blue `#0040d0`. Button labels
  stay white, so accent backgrounds are saturated/dark enough for white text in
  both modes.
- **Base text inherits the body color:** nav controls, the settings close button,
  etc. carry **no** color class — they inherit the `body` foreground
  (`zinc-900` / `zinc-100`), so they're correct in every theme with nothing to
  re-declare. Genuinely muted secondary text (timestamps, hints) keeps a muted
  shade; where high contrast needs it readable in both modes, the muted ramp
  shades (`zinc-400` / `zinc-500`) are `light-dark()` pairs — fixed once in the
  token layer instead of a `dark:` variant on every element.
- **Styling stays in Tailwind:** new widget DOM and token VNodes use literal
  Tailwind v4 utility-class strings; the only raw CSS is the theme token blocks.

## App shell & side rail

A thin, Discord-style **left rail** shared across the whole app (notes and chat
are two sections of one app). Collapsed by default it shows just an **icon** per
item; an **expand / collapse button** in the fixed bottom block toggles to **icon
+ name** (state persisted in localStorage as `sidebar-expanded`). **No
hover-to-open.** When collapsed, items carry **no boxy background hover**;
instead hovering shows an **instant label tooltip to the right** (reka-ui
`Tooltip`, portaled so it isn't clipped; `SidebarTooltip.vue`). Expanded, the
labels are inline and a subtle row hover returns. Top to bottom:

- **Top:** a **chat-bubble** button (`message-plus` icon). It routes to
  `/dm?add=1`, which opens the chat surface's in-page **Add a friend** panel
  (mint an invite code, redeem one, or create a group by name) — *not* a modal
  and *not* a friend picker. The legacy "New chat modal" with a checkbox list of
  friends does not exist in v8; a DM already exists for every friend, so there is
  nothing to create.
- **One item per conversation**, from `lib/nativeConversations.ts` (the local
  store, refreshed on every mailbox drain):
  - *DM:* the friend's initial (from their decrypted display name, else their
    handle) and, expanded, that name. **Contacts have no avatar in the rail yet**
    — profile avatars exist but the rail renders an initial.
  - *Group:* the group name's initial, expanded the name (or "Group" when
    unnamed). Custom group icons and member-initial montages are unbuilt.
  - An **unread badge** on each, and the total unread is mirrored into the window
    title (`(3) Accord`) so it's visible when the app isn't focused.
- The **Notes** item — directly **below the chats** (in flow, not pinned).
- **Bottom (fixed, separated by a top border):** expand / collapse, **Friends**,
  **Settings**, **Switch account**, **Sign out**. There is **no top app
  header** — these live in the rail. The conversation list above scrolls
  **underneath** this fixed block.

```
 collapsed      expanded
 +----+         +----------------------+
 |  + |         |  +    New chat        |  → /dm?add=1 (invite / redeem / group)
 |----|         |----------------------|
 | F  |         |  F    Foxy            |  DM, the friend's display name
 | AB |         |  AB   Alpha Bravo     |  group, initial of the group name
 | [] |         |  []   Notes           |  below the chats (not pinned)
 |    |         |                       |  (list scrolls under the block below)
 |----|         |----------------------|  ← separating border
 | >> |         |  <<   Collapse        |  expand / collapse toggle
 | U  |         |  U    Friends         |  fixed bottom controls
 | ⚙  |         |  ⚙    Settings        |
 | @  |         |  @    Switch account  |
 | ⏏  |         |  ⏏    Sign out        |  = lock the vault
 +----+         +----------------------+
```

**Ordered by most recent activity.** A v8 DM exists for each friend by
construction (its conversation id is derived from the two identity keys), so the
rail lists **one entry per friend** whether or not you've ever messaged them. The
Rust core's `conversation_activity` returns each conversation's newest-message
stamp + unread count in one call; the rail sorts by that stamp, newest first,
and breaks ties by name so a rail full of never-messaged friends doesn't
reshuffle between refreshes. Never-messaged friends sort last but stay listed —
that's how you start the first DM.

The item for the **current route** carries the active indicator (`ActiveBar`, a
left pill, plus a squircle→rounded-square icon morph): a conversation when
`/dm?open=<key>` matches it, and **Notes** when on `/`.

**Sign out re-locks the vault.** There is no server session to end, so the rail's
Sign out calls `lockVault()`; `NativeGate` then shows the unlock wall and
`App.vue` drops every decrypted store. **Switch account** opens `AccountSwitcher`
(an `AppModal`) listing each account's label with an "+ Add account" row;
selecting one restarts the app into that vault.

Implemented in `AppSidebar.vue`, mounted as the left rail in `AppLayout.vue`.
`AppLayout` is now *only* the rail plus the page content region (`<main>`) —
no header, no lock wall, no "logged in" concept, because the gate above it has
already decided all of that. `<main>` is the only thing that scrolls, so the
fixed rail controls never scroll out of view.

There is **no connection/sync status affordance** in the rail — the legacy
`syncing…` / `offline` line went with the server-backed notes sync, and notes are
now local-only with nothing to report. Online/offline, which relays are
connected, and queued-while-offline state are on the roadmap
([roadmap.md](roadmap.md#ui-surfaces-not-built)).

### The per-chat sidebar

`NativeChatSidebar.vue` sits between the rail and the messages, one per open
conversation:

- A fixed **`#chat`** entry at the top — the conversation itself, and the way
  back from an open note — then the personal tree of **pinned notes** grouped by
  **chat folders** (create / rename / delete / nest, drag-and-drop arrangement,
  pin/unpin via `PinPickerModal`). Clicking a pinned note **opens it over the
  messages** (`NoteEditor`, full pane, on the `z-modal` layer).
- **Groups have no sub-channels.** The relay's group record carries members, not
  channels, so a group's sidebar is the same `#chat` + pins tree; `#chat` is the
  group's one room. Channels arrive with the group-channel record — unbuilt.
- The sidebar is **resizable** (`ResizeHandle` + `useResizable`, width persisted)
  and collapsible.
- **Organization stays personal, and encrypted.** Folders and pins reuse the org
  store's chat namespace (keyed by conversation id) and are persisted to the
  **encrypted vault** (SQLCipher `settings`, via `settings_get`/`settings_set`).
  There is deliberately **no plaintext `localStorage` cache** of that blob —
  folder names are as sensitive as tag names and must not sit in the clear beside
  an encrypted store. (Pure view state — which folders are collapsed, pane
  widths, rail expansion — does still use `localStorage`; it reveals nothing.)

## Modals

`AppModal.vue` is the reusable shell for **primary, blocking actions** (the user
shouldn't reach the rest of the app until they finish or cancel). It wraps
reka-ui `Dialog` with an **overlay blur**, a **✕ close**, and optional
title/description/footer slots. Layout is responsive: **centered with a fixed
max-width and capped height on desktop, full-screen on mobile**. Three surfaces
are built on it today: `AccountSwitcher`, `PinPickerModal`, and `AvatarCropper`.

**Z-index layers.** One named scale is the single source of truth for stacking
(`@theme` in `style.css` → `z-<name>` utilities; never raw `z-10`/`z-[40]`). Low
→ high: `z-nav` (app chrome, side rail, per-chat sidebar, sticky headers,
in-page side panels) < `z-drawer` (slide-in side panels) < `z-modal` (`AppModal`,
the call panel, a note opened over a chat — above drawers, so a modal opened
*from* a drawer covers it) < `z-popover` (menus / dropdowns / editor toolbars —
above modals so an in-modal menu isn't clipped) < `z-lightbox` (fullscreen media
viewer) < `z-tooltip` (tooltips, toasts, the KT alarm banner).

Two layers currently have **no component**: `drawer` (the right-edge `AppDrawer`
and the group member drawer went with browser mode) and `lightbox` (the image
lightbox likewise). They stay in the scale because the scale is an *ordering
contract*, not an inventory — renumbering it when a component returns would be
worse than a gap.

## Toasts & the error catalogue

`AppToasts.vue` renders the app's one transient-message surface, on the
`z-tooltip` layer, bottom-centre, `role="status"` / `aria-live="polite"`. It is
mounted in `App.vue` **outside** the vault gate on purpose: a failure raised
*before* unlock (or by the gate itself) must still be visible.

The queue behind it is `lib/toast.ts` — a plain reactive `ref`, deliberately
**not a Pinia store**, so any module (a lib helper, a store, a component) can
raise a toast without pulling Pinia into its import graph. Toasts auto-dismiss
(errors 9s, info 4s — long enough to read two lines) and can be dismissed by
hand.

**Errors are raised by code, never by free text.** `toastError('CODE')` looks the
code up in `web/src/lib/errors/catalog.json`, which maps a stable
`SCREAMING_SNAKE` code to `{readableName, description, cause, stepsToFix[]}`. The
toast shows `readableName`, the first `stepsToFix` entry as a hint, and the raw
code in monospace so the user can search for it; the website publishes the full
entry at a per-code URL. Two decisions worth recording:

- **A code with no catalogue entry still surfaces, as the bare code.** A missing
  entry is a documentation bug, and swallowing the failure to hide it would be
  strictly worse than showing something ugly.
- **The build enforces the catalogue.** `web/test/lib/errors.test.ts` scans
  `src/` for raised codes and fails if one is undocumented, or if an entry is too
  thin to help anyone. That is what keeps "documented" from decaying into
  "documented once".

`toastInfo(message)` takes plain text — informational messages aren't failures
and have nothing to look up.

## Settings

`SettingsPage.vue` is split into **sections** navigated by a **left rail within
the page** — one section shown at a time (`v-show`, so form state persists across
switches), with the "Settings" title + close in a fixed top bar above the split.
Six sections exist:

| Section | Contents |
|---|---|
| **Profile** | E2EE display name; the public handle + **Change handle** (pick from generated `Word#1234` candidates, re-rollable, no password re-auth); E2EE avatar (via `AvatarCropper`) and bio. |
| **Appearance** | Light / dark / system, and the colour palette. |
| **Security** | Device lock only (`DeviceLockSettings`): the re-lock policy (`stay` / `on-idle` + idle minutes) and a **Lock now** button. |
| **Privacy** | Click-to-load for remote images and for video embeds; optimize-images-before-upload. |
| **Voice** | Voice activity vs push-to-talk (+ PTT key capture) and RNNoise suppression strength. Device-local. |
| **Import & export** | Export own notes to a zip of Markdown (as-written / Obsidian / standard / plain), import `.md`/`.txt`/zip. |

Gone with browser mode, and **not** hidden behind a flag: passkey management,
account password change, recovery-code regeneration, the admin **Users** and
**Invites** sections, Web Push notification settings, custom emoji, and
name colour. Unlock is the local vault gate ([native-app.md](native-app.md)),
operator tasks are the relay CLI, and there is no admin UI at all. The Settings
sections v8 still owes — Relays, Devices, Verification, Notifications, Storage,
Backup — are in [roadmap.md](roadmap.md#ui-surfaces-not-built).

One note on where things live: **Switch account** is in the side rail, not
Settings, because it restarts the app rather than changing a setting.

## Narrow-viewport navigation (`< md`)

> The **mobile shell (iOS + Android) is not built** — launch is desktop-first
> ([roadmap.md](roadmap.md#mobile-shell-ios--android)). What follows is real,
> exercised code: it drives a narrow desktop window today, and it is the layout
> the mobile shell will inherit. It is not a description of a shipped phone app.

A narrow viewport (`lib/mobileNav.ts` — `isMobile`, `matchMedia('(max-width:
767px)')`) keeps the **narrow icon rail** visible beside an **intermediary
list** — a chat's own sidebar or the notes list — and gives the whole screen to a
**leaf** (the messages, or an open note), where the rail steps aside. Desktop is
unchanged (all panes side-by-side). There is **no full-width "menu only"
state**: the rail always sits next to a list, and the app **restores your last
route on launch** (`last-route` in `router.ts`; the shell always boots at `/`).

The rail (`AppSidebar`) is a fixed `w-14` icon strip here (never the desktop
`expanded` width); it's hidden (`railHidden`) only when a leaf owns the screen.

- **Chat:** tapping a chat in the rail shows **that chat's sidebar** beside the
  rail (`chatPane = 'channels'` — the state name predates v8; the pane is the
  `#chat` + pinned-notes tree, since v8 has no channels). Tapping `#chat` or a
  pinned note shows the **messages** (or the note over them) full-screen
  (`chatPane = 'messages'` → rail hidden). `railHidden` also requires the
  conversation to actually exist in the loaded list, so a missing or
  not-yet-loaded chat can't blank the screen.
- **Notes:** the notes list shows beside the rail; tapping a note opens the editor
  full-screen (`noteOpen` → rail hidden) with its own back (`NoteEditor` `backable`,
  which clears the selection). The open note is persisted (`notes:last-open`) and
  reopened on launch; tapping **Notes** in the rail (`closeNote`) returns to the list.
- **Settings / Friends:** full pages shown beside the rail (no leaf); Settings'
  per-section drill-down opens the section full-screen (`mobileSectionOpen`) with
  a back button, and insets for the notch via `max(1.5rem, env(safe-area-inset-*))`
  longhands rather than the unlayered `.app-safe` class (which would override the
  padding utility and leave the section flush to the screen edges).
- **In a call:** the call panel (`NativeCallPanel`) is a single fixed
  bottom-right card on every viewport. The legacy split — an in-sidebar
  `CallPanel` on desktop and a `MobileCallBar` top bar on phones — is gone; a
  narrow-viewport call layout is a mobile-shell follow-up.
- **Active-item indicators** (the morph + left pill) show here too, since the
  rail stays visible next to the list.

### On-screen keyboard & input zoom

These were built against mobile browser engines and are retained for the mobile
shell, which uses the same engines (WKWebView / Android WebView). Each is a
no-op on desktop.

- **Keyboard resizes the layout viewport (Android).** The viewport meta in
  `index.html` sets `interactive-widget=resizes-content`, so when the on-screen
  keyboard opens Android Chrome shrinks the *layout* viewport — `100%`/`#app`
  resize to the space above the keyboard and `body`/`#app` stay the same height.
  Without it (the default `resizes-visual`) only the visual viewport shrank while
  `body` stayed full-height, leaving a tall blank strip and a scrollable gap
  below the shell.
- **App height tracks the visual viewport (iOS).** iOS Safari ignores
  `interactive-widget`, so `lib/viewport.ts` (`trackViewportHeight`, wired in
  `main.ts`) keeps a `--app-height` CSS variable in sync with
  `window.visualViewport.height`, and the app root uses
  `height: var(--app-height, 100%)` (`style.css`). When the keyboard opens it
  shrinks the visual viewport, so the shell resizes to the space above the
  keyboard and the chat header + message composer stay visible (instead of being
  covered, which `100vh`/`100%` would allow). Only height is set — never a
  transform on the root, which would break `position: fixed` overlays. On
  Android the visual viewport equals the (already shrunk) layout viewport, so
  this tracking is a harmless no-op.
- **No keyboard scroll-jump on iOS.** iOS Safari also scrolls the *document* to
  lift a focused input above the keyboard. Since the shell is already sized to
  the visual viewport (the input is on-screen anyway), that scroll just shoves
  the whole app up by ~the keyboard height — leaving the chat parked away from
  where the user was reading. `trackViewportHeight` pins the document back to the
  top (`window.scrollTo(0, 0)` whenever `scrollY` drifts), so focusing the
  composer leaves the message list where it was; each pane keeps its own scroll
  position. The app shell never legitimately scrolls the document (every pane has
  its own overflow container), so this is safe on desktop too.
- **No focus zoom on iOS.** A `@media (pointer: coarse)` rule bumps editable
  controls (`input`, `textarea`, `select`, `.cm-content`) to `text-base` (1rem),
  at/above the 16px threshold below which iOS Safari auto-zooms on focus.

## v8 UI model (decisions)

Foundational choices for the native client. Where a decision is built, the
implementing surface is named; the rest is tracked in
[roadmap.md](roadmap.md).

- **Multi-relay presentation = unified aggregate.** Several connected relays
  appear as **one** friends list, chat inbox and notes space; relays are
  background connectivity, not separate worlds. A subtle "via Relay X" indicator
  appears only when relevant, and relay management lives in Settings. The
  Discord-style per-relay switcher was rejected: it fights the cross-relay
  contact model and adds friction.
  - **Forced consequence — same-handle disambiguation.** Because each relay
    mints handles independently, `Alice#1234` on two relays may be **two
    different people**. Contacts are therefore keyed on **verified identity, not
    the handle string**: linked identities merge into one entry, unlinked
    same-handle contacts stay distinct, disambiguated by display name, avatar and
    verification state, with a relay tag surfaced whenever two entries would
    otherwise look identical. *(Multi-relay itself is not built — one relay
    today.)*
- **Navigation shell = keep the inherited one.** Top-level stays **Notes · Chat ·
  Friends · Settings**, reached from the one responsive rail (no drawer). All new
  v8 surfaces live **under Settings** — Relays, Devices, Verification,
  Notifications, Storage, Backup — with contextual entry points elsewhere.
  Promoting them to top-level was rejected as heavier nav for rarely-used
  screens. *(Built: the shell, plus Settings → Security device lock and change
  handle; account switching landed in the rail instead, since it restarts the
  app. The other Settings surfaces don't exist yet.)*
- **Onboarding = a single smart entry** (Welcome → New / Existing). A new user
  mints a handle, then sets up unlock with **all factors front-loaded**
  (biometric primary + mandatory password + recovery code shown and confirmed),
  because the recovery code is the break-glass unlock and the backup-export key.
  An existing user on a new device should get **pairing as the highlighted
  primary path**, with backup import as a clearly secondary fallback. *(Built:
  sign up, plus the keychain / password / recovery-code unlock wall — see
  [native-app.md](native-app.md#onboarding). The "Existing" branch is **not**
  built and is currently an honest explainer rather than a form: relay-held
  escrow was [removed](roadmap.md#escrow--removed) and pairing is unbuilt, so
  there is nothing for it to do. Also not built: the biometric prompt on the
  keychain read, the ≥2-device nudge, backup import.)*
- **Add someone / connect a relay.** "Add friend" generates an invite (QR +
  copyable link + in-app share); "I have an invite" pastes, scans or taps one.
  Redeeming an invite for a relay you're not on shows an inline "Join [relay] to
  connect with [name]?" that joins and *then* adds the friend, so it is never a
  separate step. A relay declares its **own name**, and joining offers a **local
  nickname** ("Bob's server") that overrides the display locally. A **default
  relay is deliberately deferred** — until one exists, a new user joins a relay
  during onboarding to mint their handle. *(Built: mint/redeem an invite code.
  Not built: QR and link carriers, the inline join-then-add flow, relay
  nicknames.)*
- **Contact surface = promote to a full contact page.** v8 adds per-contact
  surfaces with nowhere to live — verification/SAS, multipath reachability,
  block, shared notes and mutual groups, per-conversation notification override.
  The decision was that a quick-peek modal (avatar · name · handle · verified
  badge · "View full profile") should stay small and a **dedicated contact page**
  hold the detail, rather than cramming everything into the modal. *(Not built —
  and note that the `ProfileDialog` this was written against **no longer
  exists**: it went with browser mode. There is currently **no per-contact UI at
  all** — the Friends page lists a friend's initial, display name, handle,
  Message and Remove, and nothing opens a profile. Both the peek and the page are
  now roadmap work.)*

### Key-integrity warnings — two tiers

The severity split matters because crying wolf trains users to dismiss alarms:

- **Soft** — a *contact's key changed* with valid proofs (often just a new
  device): a non-blocking inline notice plus an "unverified again" badge,
  cleared by redoing SAS.
- **Hard** — a *split view, self-audit failure, or inconsistent roots*: a real
  relay-compromise signal, so it should render as a **blocking, non-dismissable
  banner** that halts sending to affected contacts and offers SAS re-verification
  or disconnecting the relay.

**What is actually built is the banner, not the block.** `KtAlarm.vue` (driven by
`lib/nativeKt.ts`, which runs `kt_self_audit` on connect and listens for the
core's `kt:alarm` event) shows a red, non-dismissable, `role="alert"` bar pinned
to the top of the window on the `z-tooltip` layer, naming the reason
(`split-view` vs a handle bound to a key you never created) and telling the user
to re-verify safety numbers or disconnect the relay. It is **advisory only**:
nothing in the send path consults the alarm, so a user who ignores the banner can
still send. Making the alarm actually halt sends, the **soft** tier, and the SAS
flow both tiers point at are all unbuilt — see
[roadmap.md](roadmap.md#sas-fingerprint-verification-d5) and
[key-transparency.md](key-transparency.md).
