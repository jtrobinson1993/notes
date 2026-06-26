# Accord — Spec

The spec is split by app area under [`spec/`](spec/). Start at
**[spec/README.md](spec/README.md)** for the index and tech stack.

| File | Area |
|---|---|
| [spec/accounts-and-crypto.md](spec/accounts-and-crypto.md) | Accounts, passkeys, recovery, the crypto model, the sharing primitive |
| [spec/notes.md](spec/notes.md) | Notes app + the Obsidian-style live editor + v4 folders/organization |
| [spec/ui.md](spec/ui.md) | Theming + the app shell / sidebar |
| [spec/chat.md](spec/chat.md) | v3 E2EE chat (friends, DMs, groups w/ membership + epoch re-keying) + v4 channels, as built |
| [spec/voice.md](spec/voice.md) | v6 E2EE voice (embedded mediasoup SFU, insertable-streams frame E2EE, voice channels + 1:1 calls) — implemented (`v6-voice`) |
| [spec/profiles.md](spec/profiles.md) | v3.2 E2EE editable profiles (bio + avatar), visibility, key distribution |
| [spec/notifications.md](spec/notifications.md) | Foreground chime + tab/badge unread + v3 phase 3 PWA install + content-free background Web Push |
| [spec/security.md](spec/security.md) | Rendering/XSS safety, CSP, metadata, threat model |
| [spec/roadmap.md](spec/roadmap.md) | Phasing + future versions (v3.1 – v8) |
| [spec/testing.md](spec/testing.md) | The unit + e2e test plan (Vitest + Playwright) |
