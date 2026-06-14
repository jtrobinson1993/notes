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
name** (state persisted in localStorage). **No hover-to-open.** Top to bottom:

- **Top:** a **`+`** button — start a new chat (a DM with a friend, or a group).
- One item per conversation:
  - *DM:* the other member's avatar (display-name initial fallback) and, expanded,
    their **display name**.
  - *Group:* a custom icon + name when set; otherwise a montage of each member's
    display-name first character, expanded name = members' display names listed
    out ("Alice, Bob, Carol").
- The **Notes** item — directly **below the chats** (in flow, not pinned).
- **Bottom:** the expand / collapse toggle.

```
 collapsed      expanded
 +----+         +----------------------+
 |  + |         |  +    New chat        |
 |----|         |----------------------|
 | AB |         |  AB   Alice, Bob      |  group, default icon = member initials
 | F  |         |  F    Foxy            |  DM, the friend's display name
 | ## |         |  ##   Custom Group    |  group with a custom icon + name
 | [] |         |  []   Notes           |  below the chats (not pinned)
 |    |         |                       |
 |----|         |----------------------|
 | >> |         |  <<   Collapse        |  expand / collapse toggle (bottom)
 +----+         +----------------------+
```

Implemented in `AppSidebar.vue`, mounted as a left rail in `AppLayout.vue`
(shown when logged in); the existing top header (Lock / Settings / Sign out)
stays to its right. The sidebar and header are **fixed** — only the page content
region (`<main>`) scrolls, so tall pages (e.g. Settings) never scroll the rail
out of view.
