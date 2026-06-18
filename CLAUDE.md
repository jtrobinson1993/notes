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

- **Keep specs current.** When business logic or technical behavior changes,
  update the matching file under `spec/` in the same change: edit it to match
  reality, **delete** a removed feature's section/file, or **add** a new
  `spec/<area>.md` for a new app surface — and update the `SPEC.md` table and
  `spec/README.md` index accordingly.

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

- **Never show a username to other users.** The username is a login credential;
  the only name other users ever see is the editable **display name** (with the
  neutral `User-<id-prefix>` fallback — never the username). This holds
  everywhere a user is surfaced to another user: chat (members, friend requests,
  reply quotes) and note sharing (pickers, "shared by" labels) alike.

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
