# CLAUDE.md

Working rules for this repo. See the **`spec-and-tests`** skill for the how/when.

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

## Git

- **Branch per workitem.** Start each task on a new branch off `main`; never
  commit or push directly to `main` (it's protected).
- **Commit** in small, logical units as you work.
- **Merge via PR.** When a feature looks complete, ask whether it's time to
  merge; on confirmation, push the branch, open a PR, and merge it into `main`.
