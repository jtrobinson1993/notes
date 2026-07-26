# CLAUDE.md

Working rules for this repo. See the **`spec-and-tests`** skill for the how/when.

## Security comes first

- **Never ignore a security issue.** If you spot a vulnerability, weakness, or
  questionable security tradeoff — at any point, even incidental to the task —
  surface it. Don't quietly skip it, defer it silently, or bury it in a summary.
- **Default to hardening.** When making the app more secure is just *more work*
  (no real downside, no behavior tradeoff, no product decision), do it without
  asking — that's the expected path, not a detour.
- **Escalate genuine decisions.** If closing an issue needs a judgment call
  (a UX/functionality tradeoff, a breaking change, picking between mitigations
  with real costs), stop and check with me first — describe the issue, the
  options, and your recommendation clearly.
- **Never regress security.** Do not make the app less secure, weaken an existing
  guard, or introduce/accept a vulnerability without first asking me and clearly
  describing the risk. "CodeQL says it's only a warning" / "it's probably a false
  positive" is not a reason to skip this.

## On every change

- **Test business logic.** Anything with rules/decisions — crypto & key
  handling, server DB accessors + routes (auth, IDOR, idempotency, seq/read),
  the realtime hub, Pinia stores, editor/lib behavior — must have tests
  following the existing standards (Vitest projects `crypto`/`server`/`web`;
  Playwright in `e2e/`). New logic → new tests; changed behavior → update the
  tests; bug fix → add a regression test. Never mark work done with failing or
  missing tests for changed logic.

- **Editor caret/keymap behaviour needs a real browser.** The Markdown editor
  conceals markers as **atomic** ranges, so visual caret motion (arrow keys,
  clicks) across them depends on layout geometry that **jsdom doesn't model** —
  a Vitest case can pass while the real browser misbehaves. Verify such changes
  with the standalone editor harness in **`web/dev/`** (mounts the real
  `<MarkdownEditor>`, no auth/stores): open `/dev/editor-harness.html` under
  `npm run dev:web`, or drive it headless with `node web/dev/editor-probe.mjs`.
  See `web/dev/README.md`. (HMR doesn't rebuild the mounted editor's keymap —
  full-reload after editor changes.)

- **Specs describe what exists; the roadmap describes what doesn't.** This split
  is strict, and keeping it is part of every change — not a cleanup pass later.
  - **Every feature that is built lives in a `spec/` file.** If a surface has no
    spec, add `spec/<area>.md` for it and register it in the `SPEC.md` table and
    the `spec/README.md` index. A shipped feature documented nowhere is a bug.
  - **`spec/roadmap.md` contains ONLY unimplemented work.** The moment something
    ships, delete it from the roadmap and describe it in its area spec. Never
    leave a built feature listed as planned.
  - **Update the spec in the same change as the code**, including decisions:
    when you pick an approach, reject an alternative, or discover a constraint,
    write that into the spec while the reasoning is fresh. Specs record *why*,
    not just *what*. When behavior changes, edit the spec to match reality;
    when a feature is removed, **delete** its section or file.
  - Do not describe planned behavior in an area spec as though it exists — say
    plainly that it is unbuilt and point at the roadmap.

- **Document every user-facing error** in `web/src/lib/errors/catalog.json`, a
  map of stable `SCREAMING_SNAKE` code → `{readableName, description, cause,
  stepsToFix[]}`. It is the single source of truth for error text: the app
  toasts `readableName` via `toastError('CODE')` (see `web/src/lib/toast.ts`)
  and the website publishes the full entry at a per-code URL so a user who hits
  a message can look it up. Adding a new user-visible failure means adding its
  entry in the same change — `web/test/lib/errors.test.ts` fails the build if a
  raised code is missing, or if an entry is too thin to help anyone.

- **Keep the README current.** When a change adds, removes, or meaningfully
  reshapes a user-facing feature, update the root `README.md` in the same change
  so its feature summary and setup/usage instructions still match reality —
  don't let it drift behind the spec.

- **Icons: use the Myna set** via `unplugin-icons` (`import Icon from
  '~icons/mynaui/<name>'`), never emoji glyphs or another icon pack.

- **Z-index: use the named layer scale**, never raw `z-10`/`z-[40]`. The single
  source of truth is the `@theme` block in `web/src/style.css`, exposing
  `z-<name>` utilities. Low → high: `z-nav` (app chrome / sidebar / sticky
  headers / in-page side panels) < `z-drawer` (`AppDrawer`) < `z-modal`
  (`AppModal`, above drawers) < `z-popover` (menus / dropdowns / editor toolbars,
  above modals so a menu inside a modal isn't clipped) < `z-lightbox`
  (`ImageLightbox`) < `z-tooltip` (tooltips / toasts). Add a new layer to that
  scale rather than inventing an ad-hoc value.

## Invariants

- **The handle is the only identifier; no username exists.** There is no
  user-chosen username (it was a login-only, server-readable name and has been
  removed). The name other users see is the user's public **handle**
  (`Word#1234`) by default; **contacts** additionally see the user's
  **end-to-end-encrypted display name**, which the client overlays over the
  handle (the server never sees the display name). `User-<id-prefix>` is only a
  last-resort fallback if a handle is somehow unset. This holds everywhere a user
  is surfaced to another user: chat (members, friend requests, reply quotes),
  voice, and note sharing (pickers, "shared by" labels). Server responses carry
  the handle in `displayName`; the client hydrates the real name from the
  decrypted profile. Recovery identifies the account by **handle**.

- **Friends-gate all 1:1 reach.** A user may only **DM** or **share a note** with
  a current **friend** — the server enforces friendship on DM creation and on
  note sharing, and member/recipient pickers list only friends. The *only* way to
  reach a non-friend is a **group chat** a mutual friend adds you both to
  (friends-of-friends); there is no direct DM or share with a non-friend.

## Git

- **Branch per workitem.** Start each task on a new branch off `main`; never
  commit or push directly to `main` (it's protected).
- **Commit** in small, logical units as you work.
- **Merge via PR.** When a feature looks complete, ask whether it's time to
  merge; on confirmation, push the branch, open a PR, and merge it into `main`.
- **Keep `main` current.** Always pull the latest into the local `main` (merge,
  not rebase) **after merging a PR into `main`** and **before creating a new
  branch or worktree** — so every branch starts from an up-to-date `main`.
