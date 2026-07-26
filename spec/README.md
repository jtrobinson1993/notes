# Accord — Spec

Self-hosted, end-to-end encrypted **notes + chat** app for a small private group
(invite-only, never many users). As of **v8** the app is a **native client**
holding its data in a local encrypted store, talking to a **relay that stores
nothing at rest**.

**These files describe what is built.** Anything not built yet — remaining v8
work, distribution, v9 — lives in [roadmap.md](roadmap.md).

| File | Area |
|---|---|
| [accounts-and-crypto.md](accounts-and-crypto.md) | Accounts, recovery, the master-key + X25519 crypto model, the **v8 key hierarchy**, per-relay identities, delivery tokens, escrow, revocation tiers |
| [native-app.md](native-app.md) | **The v8 native app** — why native, Tauri v2, the Rust core, the vault gate + unlock paths, idle re-lock, onboarding, multi-account, distribution & signing |
| [local-store.md](local-store.md) | **The v8 local store** — SQLCipher schema as built, the Rust-core IPC surface, message ordering, CRDT/mutable-state mapping, backfill integrity, retention |
| [relay.md](relay.md) | **The v8 relay** — wire protocol, endpoints, auth, mailbox/blob mechanics, group state, and the complete relay state inventory |
| [key-transparency.md](key-transparency.md) | **The v8 KT log** — the AKD sidecar, proof types, native client verification, gossip split-view detection, public roots endpoint, reference auditor |
| [notes.md](notes.md) | The notes app and the Obsidian-style live editor (formatting, code blocks, tables/checkboxes, attachments, import/export, history, offline) + folders, chat-sidebar pins, and sharing |
| [chat.md](chat.md) | E2EE chat — friends, DMs, groups, conversation keys/epochs, channels, the WebSocket transport, and the **v8** friends/invites, group authority, envelope payload and native chat surface |
| [voice.md](voice.md) | E2EE voice — embedded mediasoup SFU, end-to-end frame encryption, voice channels + 1:1 calls, and the **v8** device-token signaling + SFU path |
| [profiles.md](profiles.md) | E2EE editable profiles — bio + avatar, the per-user profile key, visibility, distribution + rotation |
| [notifications.md](notifications.md) | Foreground new-message chime + tab/badge unread + PWA install + content-free background Web Push, and the **v8** content-free relay wake |
| [ui.md](ui.md) | Theming (brand / pastel / high-contrast), the app shell / sidebar, the native rail + chat sidebar, and the **v8 UI model** |
| [security.md](security.md) | Cross-cutting security — rendering/XSS safety, CSP, metadata exposure, threat model, and the **v8 trust boundaries** |
| [testing.md](testing.md) | The unit + e2e test plan (Vitest + Playwright + cargo) and the WebKit editor harness |
| [roadmap.md](roadmap.md) | **Everything not built yet** |

## Tech stack (decisions)

| Area | Decision |
|---|---|
| Language | TypeScript everywhere, **plus Rust** for the native core + AKD sidecar |
| Native shell | **Tauri v2** — desktop built; mobile (iOS/Android) not built yet |
| Relay | Node 22 LTS + Fastify, SQLite (better-sqlite3), single process; runs standalone (`npm run relay:start`) |
| Frontend | Vue 3 + Vite, Pinia (+ Pinia Colada for query/cache), Reka UI components, Tailwind v4 |
| Local store | SQLite + **SQLCipher** whole-DB in the Rust core; encrypted blob files on disk |
| Realtime | `@fastify/websocket` — relay live-delivery nudge + voice signaling |
| Auth | **Device-key challenge/token** to the relay; local unlock via OS keychain + password (Argon2id) + recovery code. Passkeys are re-scoped to bootstrap auth, never load-bearing |
| Account recovery | Relay-held **wrapped-MK escrow** (password- and recovery-code-wrapped), plus the mandatory recovery code shown once at signup |
| Registration | Relay registration mode: `public` or `invite`-only (operator-minted invites, or a friend invite that also friends you) |
| Distribution | Native app, **unsigned-first** for the initial group; relay as a Docker image |
| Repo | **Public** GitHub repo `jtrobinson1993/notes`, licensed **AGPL-3.0-only** |

## Status at a glance

- **Shipped (v1–v6, legacy web app):** notes, passkeys, recovery, PWA; sharing,
  attachments, version history, offline editing, import/export, encrypted
  backups; the Obsidian-style live editor; themes + media optimization; E2EE chat
  (friends, DMs, groups with membership + epoch re-keying, channels); chat polish
  (emoji, GIFs, attachments, reactions/replies/threads, link previews); E2EE
  editable profiles; note & folder sharing with recursive grants; E2EE voice.
- **Built on the v8 branch (not yet released):** the native app + Rust core with
  a SQLCipher store, the zero-at-rest relay, the key hierarchy + escrow,
  full-AKD key transparency with client verification, DM + group messaging with
  attachments, and voice over device-token auth.
- **Next:** real-device voice validation, an integrated shakedown, then the
  greenfield cutover — see [roadmap.md](roadmap.md).
