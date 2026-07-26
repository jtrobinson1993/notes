# Accord — Spec

The spec is split by app area under [`spec/`](spec/). Start at
**[spec/README.md](spec/README.md)** for the index and tech stack.

Specs describe **what is built**. Work not yet built lives in
[spec/roadmap.md](spec/roadmap.md).

| File | Area |
|---|---|
| [spec/accounts-and-crypto.md](spec/accounts-and-crypto.md) | Accounts and the key hierarchy — vault unlock, per-relay derived identities, delivery tokens, escrow, revocation, and why passkeys are gone |
| [spec/native-app.md](spec/native-app.md) | The native app — Tauri v2 shell, the Rust core as the client, the vault gate, onboarding, multi-account, distribution |
| [spec/local-store.md](spec/local-store.md) | The local store — SQLCipher schema, the Rust-core IPC surface, message ordering, CRDT/mutable state, attachments, eviction |
| [spec/relay.md](spec/relay.md) | The relay — auth, registration, escrow, mailbox, blobs, group state, the privacy content proxies, and the complete state inventory |
| [spec/key-transparency.md](spec/key-transparency.md) | The KT log — AKD sidecar, proof types, client self-audit, gossip, public roots endpoint, reference auditor |
| [spec/notes.md](spec/notes.md) | Local-only notes, the Obsidian-style live editor, attachments, media optimization, folders and organization |
| [spec/chat.md](spec/chat.md) | E2EE chat — invite-only friends, DMs and groups, the sealed envelope and payload, ordering, CRDT overlays, and the native chat surface |
| [spec/voice.md](spec/voice.md) | E2EE 1:1 voice — the ring protocol, the embedded mediasoup SFU, frame encryption, and the fail-closed gate |
| [spec/profiles.md](spec/profiles.md) | Handles and the E2EE display name — how a name reaches a contact, and what the profile key is actually used for |
| [spec/notifications.md](spec/notifications.md) | Unread surfaces, in-app toasts and the error catalogue; the relay's content-free push wake (no client registers) |
| [spec/ui.md](spec/ui.md) | Theming, the app shell and side rail, modals, toasts, Settings, narrow-viewport navigation, and the UI model |
| [spec/security.md](spec/security.md) | Cross-cutting security — rendering/XSS safety, the content proxies and SSRF defences, rate limits, threat model, trust boundaries |
| [spec/testing.md](spec/testing.md) | How the product is tested (Vitest + Playwright + cargo), the four-layer native strategy, and the WebKit editor harness |
| [spec/roadmap.md](spec/roadmap.md) | **Everything not built yet** — remaining v8 work, known defects, distribution, the deferred web client, v9, v12 |
