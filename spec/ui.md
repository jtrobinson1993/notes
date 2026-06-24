# UI — theming & app shell

## Themes (v2.2, shipped)

Two independent axes:

- **Light / dark / system** — toggles the `.dark` class + `color-scheme` and
  drives every Tailwind `dark:` variant.
- **Color palette** — `brand` (default), `pastel`, `high-contrast` — applied as a
  `data-theme` attribute on the root element.

Both are **device-local** (localStorage `notes:theme`, `notes:palette`), not
synced, and applied **pre-paint** by a small inline `<head>` script so dark /
high-contrast never flash white on load.

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

## App shell & sidebar (v3)

A thin, Discord-style **left sidebar** shared across the whole app (notes and
chat are two sections of one app). Collapsed by default it shows just an **icon**
per item; an **expand / collapse button at the bottom** toggles to **icon +
name** (state persisted in localStorage). **No hover-to-open.** When collapsed,
items carry **no boxy background hover**; instead hovering shows an **instant
label tooltip to the right** (reka-ui `Tooltip`, portaled so it isn't clipped;
`SidebarTooltip.vue`). Expanded, the labels are inline and a subtle row hover
returns. Top to bottom:

- **Top:** a **chat-bubble** button (`message-plus` icon) — opens the **New chat
  modal** to start a DM with a friend, or a group.
- One item per conversation:
  - *DM:* the other member's avatar (display-name initial fallback) and, expanded,
    their **display name**.
  - *Group:* a custom icon + name when set; otherwise a montage of each member's
    display-name first character, expanded name = members' display names listed
    out ("Alice, Bob, Carol").
- The **Notes** item — directly **below the chats** (in flow, not pinned).

The item for the **current route** carries a highlighted background — both a
conversation when its `/chat/:id` is open and the **Notes** item when on `/`.
- **Bottom (fixed, separated by a top border):** the expand / collapse toggle,
  then **Lock** (when unlocked), **Settings**, and **Sign out**. There is **no
  top app header** — these live in the sidebar. The conversation/note list above
  scrolls **underneath** this fixed block. The notes sync status (`syncing…` /
  `offline`) shows here when expanded.

```
 collapsed      expanded
 +----+         +----------------------+
 |  + |         |  +    New chat        |
 |----|         |----------------------|
 | AB |         |  AB   Alice, Bob      |  group, default icon = member initials
 | F  |         |  F    Foxy            |  DM, the friend's display name
 | ## |         |  ##   Custom Group    |  group with a custom icon + name
 | [] |         |  []   Notes           |  below the chats (not pinned)
 |    |         |                       |  (list scrolls under the block below)
 |----|         |----------------------|  ← separating border
 | >> |         |  <<   Collapse        |  expand / collapse toggle
 | 🔒 |         |  🔒   Lock            |  fixed bottom controls
 | ⚙  |         |  ⚙    Settings        |
 | ⏏  |         |  ⏏    Sign out        |
 +----+         +----------------------+
```

Implemented in `AppSidebar.vue`, mounted as a left rail in `AppLayout.vue`
(shown when logged in). `AppLayout` has **no header** — just the rail and the
page content region (`<main>`), which is the only thing that scrolls, so the
fixed sidebar controls never scroll out of view.

## Modals

`AppModal.vue` is the reusable shell for **primary, blocking actions** (the user
shouldn't reach the rest of the app until they finish or cancel). It wraps
reka-ui `Dialog` with an **overlay blur**, a **✕ close**, and optional
title/description/footer slots. Layout is responsive: **centered with a fixed
max-width and capped height on desktop, full-screen on mobile**. `ShareDialog`,
`HistoryDialog`, the new-chat modal, and the add-group-member modal are built on it.

`AppDrawer.vue` is the same reka-ui `Dialog` foundation styled as a **slide-in
drawer** anchored full-height to the right edge — for secondary, browsable panels
(e.g. the group `ManageMembersDrawer`) where a centered modal would feel heavy.
Same overlay/close/title/footer affordances; full-screen on mobile. Its scrim is
a **light dim with no blur**, so the chat stays legible behind it.

**Z-index layers.** One named scale is the single source of truth for stacking
(`@theme` in `style.css` → `z-<name>` utilities; never raw `z-10`/`z-[40]`). Low
→ high: `z-nav` (app chrome, sidebar, sticky headers, in-page side panels) <
`z-drawer` (`AppDrawer`) < `z-modal` (`AppModal` — above drawers, so a modal
opened *from* a drawer covers it) < `z-popover` (menus/dropdowns/editor toolbars
— above modals so an in-modal menu isn't clipped) < `z-lightbox`
(`ImageLightbox`) < `z-tooltip` (tooltips, toasts).

`NewChatModal.vue` — the **New chat** modal: a search box, an **alphabetical
friend list with a checkbox per friend** (select one or many), and Cancel /
Create. One friend → a **DM**; several → a **group** (`chat.openGroup`).

## Settings

`SettingsPage.vue` is split into **sections** (Profile, Appearance, **Security**
— passkeys + recovery code, Privacy, **Voice**, Custom emoji, Import &
export, plus Invites / Users for admins) navigated by a **left rail within the
page** — one section shown at a time (`v-show`, so form state persists across
switches), with the "Settings" title + close in a fixed top bar above the split.

## Mobile navigation (phones, `< md`)

Phones (`lib/mobileNav.ts` — `isMobile` via `matchMedia`) keep the **narrow icon
rail** (the app sidebar) visible beside an **intermediary list** — a chat's
**channel list** or the **notes list** — and give the whole screen to a **leaf**
(a channel's messages or an open note), where the rail steps aside. Desktop is
unchanged (all panes side-by-side). There is **no full-width "menu only"
state**: the rail always sits next to a list, and the app **restores your last
route on launch** (`last-route` in `router.ts`; the PWA opens at `/`).

The rail (`AppSidebar`) is a fixed `w-14` icon strip on mobile (never the desktop
`expanded` width); it's hidden (`railHidden`) only when a leaf owns the screen.

- **Chat:** tapping a chat in the rail shows its **channel list** beside the rail
  (`chatPane = 'channels'`; `ChatSidebar`'s mobile header shows the chat's name).
  Tapping a channel shows its **messages** full-screen (`chatPane = 'messages'` →
  rail hidden), with a back button in the chat header (→ channel list). `railHidden`
  also requires the conversation to actually exist, so a missing/not-yet-loaded
  chat can't blank the screen.
- **Notes:** the notes list shows beside the rail; tapping a note opens the editor
  full-screen (`noteOpen` → rail hidden) with its own back (`NoteEditor` `backable`,
  which clears the selection). The open note is persisted (`notes:last-open`) and
  reopened on launch; tapping **Notes** in the rail (`closeNote`) returns to the list.
- **Settings / Friends:** full pages shown beside the rail (no leaf); Settings'
  per-section drill-down is unchanged (`mobileSectionOpen`).
- **In a call:** the call controls + speaking indicators move to a **top bar**
  (`MobileCallBar`, in the app's flex column) so the rest of the app shrinks
  below it; the in-sidebar `CallPanel` is hidden on mobile.
- **Active-item indicators** (the morph + left pill) show on mobile too, since the
  rail stays visible next to the list.

### On-screen keyboard & input zoom

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
  transform on the root, which would break `position: fixed` modals/lightbox. On
  Android the visual viewport equals the (already shrunk) layout viewport, so
  this tracking is a harmless no-op.
- **No focus zoom on iOS.** A `@media (pointer: coarse)` rule bumps editable
  controls (`input`, `textarea`, `select`, `.cm-content`) to `text-base` (1rem),
  at/above the 16px threshold below which iOS Safari auto-zooms on focus.
