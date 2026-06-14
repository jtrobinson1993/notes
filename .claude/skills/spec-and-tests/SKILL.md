---
name: spec-and-tests
description: Use whenever you change business logic or technical behavior in this repo (crypto/key handling, server routes/db, the realtime hub, Pinia stores, editor/lib logic, or the auth/chat/notes flows). Ensures the change is tested to the project's standards AND the matching spec/ file is updated — editing it, deleting a removed feature, or adding a new spec file for a new app surface.
---

# Keeping tests and specs in sync

Two obligations on any change to business logic or technical specs. Do both in
the same change, before declaring it done.

## When this applies

Business logic = anything with rules/decisions, not pure glue: crypto & key
wrapping/sealing, server DB accessors + routes (auth, IDOR, idempotency,
seq/read markers), the realtime hub, Pinia stores, editor/`lib` behavior, and
the user-visible auth/chat/notes flows. If you touched one of these, both steps
below apply.

## 1. Test the business logic

- **New logic** → add tests. **Changed behavior** → update the tests so they
  lock the new contract. **Bug fix** → add a regression test that fails before
  the fix and passes after.
- Mirror neighbouring tests; match the existing standards:
  - **Vitest projects** (`vitest.config.ts`): `crypto` + `server` run under
    Node, `web` under jsdom. Tests live in `server/test/` and `web/test/`.
  - **Server routes**: use the auth seam in `test/helpers/server.ts`
    (`makeApp`, `seedUser`, `authCookie`) with `app.inject()` — no network, no
    passkey ceremony. DB/crypto get a fresh instance per test.
  - **Stores**: mock `../lib/api` and `../stores/session`; assert observable
    state. **Components**: Vue Test Utils, stub the router and heavy children.
  - **User-visible flows**: Playwright in `e2e/` (`npm run e2e`).
- Run `npm test` (and `npm run coverage` for the gates) and make it green.
  Never leave changed logic with failing or missing tests.

## 2. Update the matching spec

`spec/` is the source of truth, indexed by the `SPEC.md` table and
`spec/README.md`. Areas: `accounts-and-crypto`, `notes`, `ui`, `chat`,
`security`, `roadmap`, `testing`.

- **Changed behavior/design** → edit the relevant `spec/<area>.md` to match
  reality.
- **Removed feature** → delete its section, or the whole file if the surface is
  gone, and drop its row from `SPEC.md` and `spec/README.md`.
- **New feature / app surface** → add a new `spec/<area>.md` and link it from
  `SPEC.md` and `spec/README.md`.

Pick the file by area; if it's a genuinely new surface, create a new file rather
than wedging it into an unrelated one. The change isn't done until the spec
reflects it.
