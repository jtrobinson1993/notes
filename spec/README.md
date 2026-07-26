# Accord — Spec

Self-hosted, end-to-end encrypted **notes + chat** app for a small private group
(invite-only, never many users). As of **v8** the app is a **native desktop
client** holding its data in a local encrypted store, talking to a **relay that
stores nothing at rest**. There is no browser client and no hosted service.

**These files describe what is built.** Anything not built yet — remaining v8
work, known defects, distribution, a future web client, v9 — lives in
[roadmap.md](roadmap.md).

| File | Area |
|---|---|
| [accounts-and-crypto.md](accounts-and-crypto.md) | Accounts and the **key hierarchy** — master key, vault unlock (keychain / Argon2id password / recovery code), domain separation, the sealed envelope, per-relay derived identities, delivery tokens, escrow, revocation, and why passkeys are gone |
| [native-app.md](native-app.md) | **The native app** — why native, Tauri v2, the Rust core as the real client, the vault gate + unlock paths, idle re-lock, onboarding, multi-account, distribution & signing |
| [local-store.md](local-store.md) | **The local store** — SQLCipher schema as built, the 79-command Rust-core IPC surface, message ordering, CRDT/mutable-state mapping, attachments on device, backfill integrity, eviction |
| [relay.md](relay.md) | **The relay** — posture and complete state inventory, device-token auth, registration, escrow, sealed-sender mailbox, blob store, directory/KT, group state, invites, and the privacy content proxies |
| [key-transparency.md](key-transparency.md) | **The KT log** — the AKD sidecar, proof types, native self-audit, gossip split-view detection, the public roots endpoint, the reference auditor |
| [notes.md](notes.md) | **Local-only notes** and the Obsidian-style live editor — formatting, code blocks, tables/checkboxes, attachments, media optimization, zip import/export, folders and organization |
| [chat.md](chat.md) | **E2EE chat** — invite-only friends as a capability handshake, DMs and groups, the sealed envelope + payload, ordering without a server counter, the CRDT overlays, the mailbox drain, and the native chat surface |
| [voice.md](voice.md) | **E2EE 1:1 voice** — the sealed ring, relay signaling, the embedded mediasoup SFU, frame encryption, and the fail-closed gate that refuses a call without it |
| [profiles.md](profiles.md) | **Handles and the E2EE display name** — what the relay sees, how a name reaches a contact (once, inside the friend handshake), and the profile key's single real job |
| [notifications.md](notifications.md) | **Unread surfaces, in-app toasts and the error catalogue** — plus the relay's content-free push wake, which is built but has no client half |
| [ui.md](ui.md) | **Theming** (brand / pastel / high-contrast), the app shell and side rail, the per-chat sidebar, modals, toasts, Settings, narrow-viewport navigation, and the UI model |
| [security.md](security.md) | **Cross-cutting security** — rendering/XSS safety, click-to-load remote media, the relay content proxies and their SSRF defences, voice failing closed, rate limits, threat model, trust boundaries |
| [testing.md](testing.md) | **How the product is tested** — the Vitest projects, cargo tests and the relay Playwright suite as they run today, the four-layer native strategy (L1 built, L2–L4 not), and the WebKit editor harness |
| [roadmap.md](roadmap.md) | **Everything not built yet** |

## Tech stack (decisions)

| Area | Decision |
|---|---|
| Language | TypeScript everywhere, **plus Rust** for the native core + AKD sidecar |
| Native shell | **Tauri v2** — desktop built; mobile (iOS/Android) not built yet |
| Relay | Node 22 LTS + Fastify, SQLite (better-sqlite3), single process; the only server, run standalone (`npm run relay:start`) |
| Frontend | Vue 3 + Vite, Pinia (+ Pinia Colada for query/cache), Reka UI components, Tailwind v4 |
| Local store | SQLite + **SQLCipher** whole-DB in the Rust core; encrypted blob files on disk |
| Realtime | `@fastify/websocket` — relay live-delivery nudge + voice signaling |
| Auth | **Device-key challenge/token** to the relay; local unlock via OS keychain + password (Argon2id) + recovery code. **No passkeys, no server session, no cookie** |
| Account recovery | Relay-held **wrapped-MK escrow** (password- and recovery-code-wrapped), plus the mandatory recovery code shown once at signup — the client half is not wired yet, see [roadmap.md](roadmap.md#escrow--upload-cold-start-and-device-re-enrolment) |
| Registration | Relay registration mode: `public` or `invite`-only (operator-minted invites, or a friend invite that also friends you). No admin role and no first-user bypass |
| Distribution | Native app, **unsigned-first** for the initial group; relay as a Docker image |
| Repo | **Public** GitHub repo `jtrobinson1993/notes`, licensed **AGPL-3.0-only** |

## Status at a glance

- **Built and specced here:** the Tauri shell + Rust core over a SQLCipher store;
  the zero-at-rest relay with device-token auth, sealed-sender mailbox, blob
  store and the privacy content proxies; the key hierarchy, vault unlock and the
  sealed envelope; full-AKD key transparency with client self-audit and gossip;
  DM + group messaging with attachments and the CRDT overlays; 1:1 voice that
  fails closed without frame E2EE; local notes with the live editor, folders and
  import/export; the toast surface and error catalogue.
- **Deleted, not deprecated:** the v1–v6 browser product — the passkey SPA, the
  all-in-one Fastify server, the PWA/service worker, the IndexedDB note cache,
  the session/CSRF layer, the admin UI and the test-auth seam. Nothing in these
  specs describes it except where a section explains what replaced it.
- **Next:** real-device voice validation, an integrated shakedown, the defects
  listed in the roadmap, then the greenfield cutover — see
  [roadmap.md](roadmap.md).
