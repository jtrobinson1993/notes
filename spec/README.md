# notes — Spec

Self-hosted, end-to-end encrypted **notes + chat** app for a small private group
(invite-only, never many users). The server stores only ciphertext.

This spec is split by app area so you can load just the part you're working on:

| File | Area |
|---|---|
| [accounts-and-crypto.md](accounts-and-crypto.md) | Accounts, passkeys, recovery, the master-key + X25519 crypto model, the sharing primitive |
| [notes.md](notes.md) | The notes app and the Obsidian-style live editor (formatting, code blocks, tables/checkboxes, attachments, import/export, history, offline) |
| [ui.md](ui.md) | Theming (brand / pastel / high-contrast) and the app shell / sidebar |
| [chat.md](chat.md) | v3 E2EE chat — friends, DMs, conversation keys/epochs, the WebSocket transport, **and the phase-1 implementation as built** |
| [security.md](security.md) | Cross-cutting security — rendering/XSS safety, CSP, metadata exposure, threat model |
| [roadmap.md](roadmap.md) | Phasing and future versions (v3.1 – v5) |
| [testing.md](testing.md) | The unit + e2e test plan (Vitest + Playwright) |

## Tech stack (decisions)

| Area | Decision |
|---|---|
| Language | TypeScript everywhere |
| Server | Node 22 LTS + Fastify, SQLite (better-sqlite3), single process |
| Frontend | Vue 3 + Vite, Pinia (+ Pinia Colada for query/cache), Reka UI components, Tailwind v4 |
| Realtime | `@fastify/websocket` (chat) |
| Mobile | PWA (installable, offline shell) — no native apps |
| Auth | Passkeys only (WebAuthn, `@simplewebauthn`). No passwords, no SSO. Multiple passkeys per account encouraged |
| Account recovery | Mandatory recovery code at signup (random ≥128-bit, shown once). No other recovery path |
| Registration | Admin-generated invite links; the invitee creates their own account + passkey |
| Distribution | Single multi-arch Docker image (amd64/arm64); install = one `docker run`/compose command |
| Repo | Private GitHub repo `jtrobinson1993/notes` |

## Status at a glance

- **Shipped:** v1 (notes, passkeys, recovery, PWA), v2 (sharing, attachments, version history, offline editing, import/export, encrypted backups), v2.1 (Obsidian-style live editor), v2.2 (themes, media optimization, block-level live rendering).
- **In progress:** v3 **phase 1** (friends + 1:1 DMs over WebSocket) — implemented; see [chat.md](chat.md#phase-1--as-built).
- **Planned:** v3 phases 2–3 (groups + epochs, CSP, PWA push), then v3.1 – v5 — see [roadmap.md](roadmap.md).
