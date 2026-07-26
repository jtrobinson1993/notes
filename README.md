# Accord

End-to-end encrypted **notes, chat and voice** for a small private group.

Accord is a **native desktop app** (Tauri v2). A Rust core owns the master key,
an encrypted local database (SQLCipher) and all networking; the Vue UI runs in
the webview and never touches key material. Its only backend is a **relay** you
self-host: a message relay that stores nothing at rest, never sees plaintext,
and never learns who sent an envelope.

There is no browser client and no hosted service — you run the relay, everyone
runs the app. See [the spec](spec/README.md) for the design and the reasoning.

## What's in the app

- **A local vault.** Everything durable lives on your device in a SQLCipher
  database (notes, messages, contacts, settings) plus encrypted attachment blob
  files. Unlock is local: silent via a key in the OS keychain, with a password
  (Argon2id) and a one-time recovery code as the other two ways in. **Sign out**
  locks the vault; Settings → Device lock can also re-lock after N idle minutes.
- **Accounts by handle.** Signing up mints a `Word#1234` **handle** on a relay;
  friends additionally see an end-to-end-encrypted **display name** the relay
  never sees. There is no username and no password login — a device
  authenticates to the relay with a device key.
- **Notes.** Markdown notes with tags, nestable folders, client-side search, and
  an Obsidian-style live-preview editor (concealed markup, formatting shortcuts,
  colors, spoilers, syntax-highlighted code blocks, tables/checkboxes,
  click-to-load images and video embeds). Attachments are encrypted per file and
  stored locally. Import/export is a zip of Markdown files, done entirely on
  device (Settings → Import & export).
- **Chat.** 1:1 DMs and group chats: text, encrypted attachments, and — in DMs —
  edit, delete and reactions (the group fan-out for those is a follow-up, as are
  threaded replies). Envelopes are sealed to the recipient — the relay
  sees an opaque blob addressed by a *delivery token*, not a sender. Each chat
  has its own sidebar where you can **pin** notes into nested folders; pinning is
  private and does not share the note.
- **Reach is capability-gated.** Someone can only put mail in your mailbox if
  they hold your delivery token, which you hand out by accepting an **invite**
  (`accord://friend?i=…`, minted in-app and shared out of band) — so there is no
  cold-contact path and the relay never stores a friend graph. A group chat is
  the only way to talk to someone who isn't a friend.
- **Voice.** 1:1 calls from a DM, relayed through the mediasoup SFU embedded in
  the relay (no peer-to-peer, so no participant learns another's IP). Audio
  frames are end-to-end encrypted and the SFU forwards media it cannot decode.
  It **fails closed**: a webview without WebRTC Encoded Transform cannot place or
  accept a call at all, rather than silently downgrading to plaintext Opus.
- **Key transparency.** The relay publishes a signed, append-only log of
  handle → identity-key bindings. On connecting, the app audits *its own* handle
  against the log's key history and exchanges signed epoch roots with contacts
  to catch a relay showing different logs to different people; either failure
  raises a non-dismissable alarm banner. A contact's key itself comes from the
  invite you accepted, pinned on first use — the relay is not asked for it, and
  the human out-of-band check (SAS) that would confirm a pin is unbuilt.
- **Multiple accounts.** Each account is its own vault (own master key, store and
  relay identity) in its own data directory; switching restarts the app.

### Not built yet

Named here so the feature list above isn't read as more than it is. The full
list, with designs, is [spec/roadmap.md](spec/roadmap.md).

- **Notes are local-only.** No relay sync, no sharing with another user, no
  version history, no collaborative editing.
- **Desktop only.** No iOS/Android shell, and no browser client (deferred
  deliberately — a browser can't hold the Rust core's trust properties).
- **One device per account.** Device pairing and history transfer aren't built.
  Escrow restore (handle + password) rebuilds the master key and identity on a
  new install, but not your history — and, since a device can only enroll with
  the relay during registration, a restored install cannot yet connect to the
  relay to send or receive. There is also no encrypted backup export, so losing
  every device loses history.
- **No notifications outside the app.** Unread counts appear in the sidebar and
  the window title; there is no OS notification, no sound, and nothing registers
  for the relay's content-free push wake.
- **Group membership only grows.** Create and add-member work; removing a member
  (with the group-key rotation that must accompany it) and leaving a group don't.
- **GIF search, link previews and 7TV emotes are relay-side only.** The proxies
  exist and are tested on the relay; nothing in the app calls them yet.
- **SAS fingerprint verification** — the out-of-band way to confirm a contact's
  key without trusting the relay — is specified but unbuilt.
- Builds are **unsigned** for now, so every OS will warn on first launch.

## Running the relay

The relay is the only server. It serves `/api/relay/*` and a health probe — no
web app, no accounts UI — and is administered by a CLI, not a browser.

### Docker (recommended)

Works anywhere Docker runs: Debian/Linux, Windows (Docker Desktop / WSL2), macOS.

```sh
git clone https://github.com/jtrobinson1993/notes.git && cd notes
cp .env.example .env        # set APP_ORIGIN to the relay's public URL, then:
docker compose up -d
```

Compose runs the relay behind **Caddy**, which gets HTTPS certificates
automatically, alongside the optional `akd-sidecar` (see
[key transparency](#key-transparency) below). It pulls a prebuilt image so
nothing compiles on the server. See [DEPLOY.md](DEPLOY.md) for the full
walkthrough (DNS, releases, rollback).

Or a single container without compose (you supply your own TLS):

```sh
docker build -t notes .
docker run -d --name notes --restart unless-stopped \
  -p 3000:3000 \
  -e APP_ORIGIN=https://relay.example.com \
  -v notes-data:/data \
  notes
```

Then mint an invite (below) and enter it in the app's onboarding. Nothing is
created by opening the URL in a browser — there is nothing to open.

### Serve it over HTTPS

Device tokens, escrow blobs and KT roots all ride these endpoints, so a real
deployment must terminate TLS. The compose setup does it for you; behind your
own proxy:

```
relay.example.com {
    reverse_proxy localhost:3000
}
```

**Pick the hostname before anyone joins.** Clients store the relay URL they
registered against, and a per-account identity derived from the relay's identity
key; there is no signed "the relay moved" record yet (roadmap), so changing the
URL strands existing installs.

### Configuration

| Env var | Default | Meaning |
|---|---|---|
| `APP_ORIGIN` | `http://localhost:3000` | Public URL of the relay (drives HSTS/CSP, the Caddy certificate, and the default push subject) |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen port and interface |
| `DATA_DIR` | `/data` (in Docker) | Where the SQLite database, blobs and backups live |
| `RELAY_REGISTRATION_MODE` | `invite` | Who may create an account: `invite` (a valid invite is always required) or `public` (anyone) |
| `RATE_LIMIT_MAX` | `600` | Per-IP requests/minute for the global limiter (registration gets a tighter bucket) |
| `BACKUP_INTERVAL_HOURS` | `24` | Periodic SQLite backup interval (0 disables) |
| `BACKUP_KEEP` | `14` | Number of backups to retain |
| `KLIPY_API_KEY` | unset | Enables the relay-side GIF-search proxy (no client ever reaches Klipy) |
| `VOICE_ANNOUNCED_IP` | `127.0.0.1` | Public/LAN IP clients reach for voice media — set for non-local calls |
| `VOICE_LISTEN_IP` | `0.0.0.0` | Interface the voice media server binds to |
| `VOICE_RTC_MIN_PORT` / `VOICE_RTC_MAX_PORT` | `40000` / `40100` | UDP/TCP port range for voice media |
| `AKD_SIDECAR_TOKEN` | unset | Shared secret enabling the full-AKD KT sidecar (empty = interim Merkle KT) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | generated | Web Push keys; generated into `DATA_DIR/vapid.json` if unset. No client subscribes yet |

All state lives in `DATA_DIR` — back up that one directory. It holds ciphertext,
public keys and hashes only.

### The operator CLI

Operator tasks are `npm run relay -- <command>`, which acts directly on
`DATA_DIR` — no running server required. Use an **absolute** `DATA_DIR` so the
CLI and the relay always agree on which database they mean (or set it in `.env`,
which both read).

```sh
DATA_DIR=/srv/accord-data npm run relay -- create-invite [--days N]  # one-time signup code
DATA_DIR=/srv/accord-data npm run relay -- list-devices              # enrolled devices
DATA_DIR=/srv/accord-data npm run relay -- revoke-device <id>        # revoke a device
DATA_DIR=/srv/accord-data npm run relay -- status                    # accounts / devices / mode
DATA_DIR=/srv/accord-data npm run relay -- prune                     # drop expired/used invites
```

Under compose the same commands run inside the container:

```sh
docker compose exec notes node server/dist/relay-cli.js status
```

On an invite-only relay **every** account needs a code — there is no admin or
first-user bypass, and no admin role exists at all. Mint one with `create-invite`
for yourself and each new member; existing users can also invite friends from
inside the app, and that invite additionally establishes the friendship.

### Voice networking

Voice is end-to-end encrypted and relayed through a mediasoup SFU embedded in
the relay (no second service to run). For calls to connect **off localhost**:

1. Set `VOICE_ANNOUNCED_IP` to the public/LAN IP clients can reach the host at.
2. Publish **and** port-forward the RTC range `40000–40100` (UDP, with TCP
   fallback) — the compose file and Dockerfile already declare it.

See [spec/voice.md](spec/voice.md).

### Key transparency

The relay publishes a **key-transparency log** over its handle → key directory,
so a relay that quietly rebinds a handle to a key of its own cannot do it
invisibly: every client audits its own handle against the log, and anyone can
audit the log itself. Out of the box it runs an
**interim** log (signed, hash-chained epoch roots + Merkle inclusion proofs).
For the full **AKD** log — VRF-blinded labels (the directory can't be
enumerated) and append-only *consistency* proofs — set a shared secret and the
bundled `akd-sidecar` service takes over:

```sh
# in .env
AKD_SIDECAR_TOKEN=$(openssl rand -base64 32)
```

`docker compose up -d` then runs the sidecar alongside the relay (compose
network only, no exposed port; the relay authenticates with the token). Leave
the token empty to stay on the interim log.

Anyone can audit a relay's log from its public endpoints — `GET
/api/relay/kt/roots` (also at `/.well-known/accord/kt-roots`) — with the
reference auditor, which verifies the root signatures and hash chain and alarms
on a rewritten epoch or a stalled log:

```sh
npm run kt-audit -- https://relay.example.com --watch
```

An operator auditing its own log proves nothing, so the recommendation is that
**someone other than the operator** runs this. See
[spec/key-transparency.md](spec/key-transparency.md).

## How the encryption works

- **The Rust core holds every key.** The webview asks for operations
  (`relay_send`, `envelope_open`, `attachment_fetch`) and gets results; key
  material never crosses the IPC boundary.
- **Master key (MK).** A random 256-bit key generated on the device at signup. It
  never leaves the device and only ever rests **wrapped**, three ways:
  - under a **vault key in the OS keychain** — the primary, silent unlock;
  - under **Argon2id(password)** (m ≈ 19 MiB, t = 2, p = 1) — the portable path,
    and what an escrow restore on a new device uses;
  - under a **160-bit recovery code**, shown once at signup — break-glass.

  The wrapped blobs and public KDF parameters sit in a plaintext sidecar
  (`vault.meta.json`); everything in it is either public parameters or MK under a
  strong secret. Wrapping is HKDF-SHA-256 (domain-separated per path) →
  AES-256-GCM.
- **The local database is encrypted whole** with a separate per-device SQLCipher
  key, also in the OS keychain, so rows, indexes and metadata are all encrypted
  at rest and local search still works. Attachment blobs on disk are encrypted
  under their own per-file keys.
- **Per-relay identity.** Ed25519 signing + X25519 sealing keys are derived from
  MK and the relay's identity fingerprint, so two relays cannot correlate you by
  key, and the same account on a new device re-derives the same identity.
- **Sealed sender.** A message is sealed to the recipient's X25519 key and posted
  with a **delivery token** — a capability derived from the recipient's profile
  key that only their friends hold. The relay checks a hash of the token,
  forwards the opaque envelope, and deletes it on ack. It never learns the
  sender.
- **Escrow.** MK wrapped by the password and by the recovery code is stored on
  the relay so a fresh install can rebuild the vault from handle + password
  (identity only — see "Not built yet"). The fetch credential is
  domain-separated from the wrapping key, so the secret presented to *fetch* an
  escrow blob cannot *unwrap* it.
- **Voice frames** are encrypted per frame with a call key exchanged E2E; the SFU
  forwards ciphertext. See the fail-closed note above.
- **Errors are catalogued.** Every user-visible failure is a stable code in
  `web/src/lib/errors/catalog.json` (with cause and fix steps) raised as a toast,
  so a message can be looked up rather than guessed at.

What the relay can still see is enumerated in
[spec/relay.md](spec/relay.md#state-inventory) — read that rather than assuming.

## Running locally

### The native app

Prerequisites: Node ≥ 22, a Rust toolchain, and the Tauri v2 system
dependencies for your OS.

**Dev mode** (hot reload, two terminals):

```sh
npm install
npm run build -w shared                              # build shared types once

# terminal 1 — the relay on :3000 (tsx watch, data in an ABSOLUTE DATA_DIR)
DATA_DIR=$PWD/relay-data npm run relay:dev

# terminal 2 — the native window, frontend served by Vite with HMR
npm run dev:native
```

Then mint an invite for yourself against that same data dir
(`DATA_DIR=$PWD/relay-data npm run relay -- create-invite`), or start the relay
with `RELAY_REGISTRATION_MODE=public` while hacking.

`dev:native` starts Vite on :5173 and points the native window at it, so **the
whole frontend hot-reloads into the running app** — edit a `.vue`/`.ts` file and
the change lands without a rebuild or restart. Editing anything under
`src-tauri/` triggers an incremental `cargo` rebuild and relaunches the window
(a few seconds); the vault survives, since it lives in the app data dir.

The webview's console output is piped to the terminal running `dev:native`, so
client-side errors show up there — no need to open devtools to catch them.

> **<http://localhost:5173> in a browser is *not* the app.** Every surface
> delegates to the Rust core over `invoke()`, which a browser doesn't have, so
> the page is inert there. Use the native window. The one exception is the
> standalone editor harness (`web/dev/`, see [web/dev/README.md](web/dev/README.md)),
> which mounts the real `<MarkdownEditor>` with no vault or stores and is the
> right way to check caret/keymap behaviour in a real engine.

**Release build** (installers into `src-tauri/target/release/bundle/`):

```sh
npm run build:native
```

### The relay, without Docker

```sh
npm run build                                   # shared + server
DATA_DIR=$PWD/relay-data npm start              # http://localhost:3000
```

`npm start` and `npm run relay:start` are the same thing —
`server/dist/relay-index.js`.

### Checks

```sh
npm run typecheck    # shared + server + web
npm test             # Vitest: crypto / server / web projects
cargo test --manifest-path src-tauri/Cargo.toml    # the Rust core
npm run build && npm run e2e                       # Playwright against the real relay
```

The Playwright suite boots the built relay on a throwaway `DATA_DIR` and drives
its HTTP surface, including real account registration — there is no test-only
auth bypass. Native UI has no browser-drivable form, so it isn't covered there;
see [spec/testing.md](spec/testing.md).

### Docker on macOS (Colima)

Docker containers need a Linux kernel, so on a Mac they run inside a lightweight
VM — Colima provides one without Docker Desktop. One-time setup:

```sh
brew install colima docker docker-compose
colima start                 # boots the VM; rerun after a reboot
                             # (or: brew services start colima)
```

Then the normal Docker flow works, same as on a Linux server:

```sh
docker build -t notes .
docker run -d --name notes --restart unless-stopped \
  -p 3000:3000 -v notes-data:/data notes
```

The relay is then at `http://localhost:3000` — point the app's onboarding at it.
Data persists in the `notes-data` volume across rebuilds; `docker rm -f notes`
plus the `docker run` again swaps in a new build. Colima is macOS-only — on a
Linux server Docker runs natively (see [DEPLOY.md](DEPLOY.md)).

## Stack

Rust for the native core (Tauri v2, rusqlite + SQLCipher, ed25519-dalek /
x25519-dalek / AES-GCM / Argon2, `akd_core` for KT proofs) and for the
`akd-sidecar`. TypeScript everywhere else: Vue 3 + Pinia + Pinia Colada + Reka
UI + Tailwind v4 built with Vite (UI), Fastify + better-sqlite3 + mediasoup
(relay).

## License

[AGPL-3.0-only](LICENSE). Self-hosting is free; if you run a modified version
as a network service, the AGPL requires you to publish your modifications.
