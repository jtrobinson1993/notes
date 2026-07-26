# Accord — Spec

The spec is split by app area under [`spec/`](spec/). Start at
**[spec/README.md](spec/README.md)** for the index and tech stack.

Specs describe **what is built**. Work not yet built lives in
[spec/roadmap.md](spec/roadmap.md).

| File | Area |
|---|---|
| [spec/accounts-and-crypto.md](spec/accounts-and-crypto.md) | Accounts, recovery, the crypto model, the v8 key hierarchy + escrow, the sharing primitive |
| [spec/native-app.md](spec/native-app.md) | The v8 native app — Tauri shell, the vault & unlock, onboarding, multi-account, distribution |
| [spec/local-store.md](spec/local-store.md) | The v8 local store — SQLCipher schema, the Rust-core IPC boundary, ordering, CRDTs, retention |
| [spec/relay.md](spec/relay.md) | The v8 relay — wire protocol, endpoints, and the complete state inventory |
| [spec/key-transparency.md](spec/key-transparency.md) | The v8 KT log — AKD sidecar, proofs, client verification, gossip, reference auditor |
| [spec/notes.md](spec/notes.md) | Notes app + the Obsidian-style live editor + folders/organization + sharing |
| [spec/chat.md](spec/chat.md) | E2EE chat — friends, DMs, groups, channels, and the v8 messaging model |
| [spec/voice.md](spec/voice.md) | E2EE voice — embedded mediasoup SFU, frame E2EE, voice channels + 1:1 calls |
| [spec/profiles.md](spec/profiles.md) | E2EE editable profiles (bio + avatar), visibility, key distribution |
| [spec/notifications.md](spec/notifications.md) | Foreground chime + unread + PWA push + the v8 content-free relay wake |
| [spec/ui.md](spec/ui.md) | Theming, the app shell / sidebar, and the v8 UI model |
| [spec/security.md](spec/security.md) | Rendering/XSS safety, CSP, metadata, threat model, v8 trust boundaries |
| [spec/testing.md](spec/testing.md) | The unit + e2e test plan (Vitest + Playwright + cargo) and the WebKit editor harness |
| [spec/roadmap.md](spec/roadmap.md) | **Everything not built yet** — remaining v8 work, distribution, v9, v12 |
