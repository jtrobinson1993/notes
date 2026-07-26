# Accord

Self-hosted, end-to-end encrypted notes &amp; chat for a small private group.
Passkey-only sign-in, invite-only registration, Markdown notes with tags and
an Obsidian-style live-preview editor (concealed markup, formatting shortcuts,
colors, spoilers, syntax-highlighted code blocks, click-to-load video embeds),
note sharing between users, encrypted attachments,
version history, offline editing with conflict handling, import/export, and an
installable PWA with an encrypted offline cache. The server only ever stores
ciphertext — it cannot read your notes. See [the spec](spec/README.md) for design details.

## Install (Docker)

Works anywhere Docker runs: Debian/Linux, Windows (Docker Desktop / WSL2), macOS.

```sh
git clone https://github.com/jtrobinson1993/notes.git && cd notes
cp .env.example .env        # set APP_ORIGIN to your public URL, then:
docker compose up -d
```

Compose runs the app behind **Caddy**, which gets HTTPS certificates
automatically, and pulls a prebuilt image so nothing builds on the server. See
[DEPLOY.md](DEPLOY.md) for the full server walkthrough (DNS, releases, rollback).

Or a single container without compose (you supply your own TLS — see below):

```sh
docker build -t notes .
docker run -d --name notes --restart unless-stopped \
  -p 3000:3000 \
  -e APP_ORIGIN=https://notes.example.com \
  -v notes-data:/data \
  notes
```

Then open the app — the first account created becomes the admin. Invite others
from **Settings → Invites**.

### HTTPS is required

Passkeys (WebAuthn) only work in a secure context: either `http://localhost`
(fine for trying it out) or **HTTPS**. The compose setup above handles this for
you — Caddy is bundled and terminates TLS. If you run the single container
without compose, put it behind your own reverse proxy with TLS, e.g. Caddy:

```
notes.example.com {
    reverse_proxy localhost:3000
}
```

`APP_ORIGIN` must exactly match the URL in the browser (scheme + host + port) —
passkeys are cryptographically bound to it, so changing it later will strand
existing passkeys.

### Configuration

| Env var | Default | Meaning |
|---|---|---|
| `APP_ORIGIN` | `http://localhost:3000` | Public URL of the app (WebAuthn origin) |
| `PORT` | `3000` | Listen port |
| `DATA_DIR` | `/data` (in Docker) | Where the SQLite database lives |
| `APP_NAME` | `Accord` | Display name |
| `RELAY_REGISTRATION_MODE` | `invite` | Who may create an account: `invite` (a valid invite is always required — mint one with the relay CLI) or `public` (anyone) |
| `BACKUP_INTERVAL_HOURS` | `24` | Periodic SQLite backup interval (0 disables) |
| `BACKUP_KEEP` | `14` | Number of backups to retain |
| `VOICE_ANNOUNCED_IP` | `127.0.0.1` | Public/LAN IP clients reach for voice media — set for non-local calls |
| `VOICE_LISTEN_IP` | `0.0.0.0` | Interface the voice media server binds to |
| `VOICE_RTC_MIN_PORT` / `VOICE_RTC_MAX_PORT` | `40000` / `40100` | UDP/TCP port range for voice media |

All state lives in `DATA_DIR` — back up that one directory (it only contains
encrypted notes and public keys).

### Running the relay (v8, native app)

The v8 native app talks to a **standalone relay** — a zero-knowledge message
relay with no web frontend and no accounts UI. It is **operator-controlled via a
CLI**, not a browser:

```sh
# Start just the relay (only /api/relay/* — no legacy web app). Use an ABSOLUTE
# DATA_DIR so the CLI and server always agree on the database.
DATA_DIR=/srv/accord-data RELAY_REGISTRATION_MODE=invite npm run relay:dev   # dev (tsx watch)
DATA_DIR=/srv/accord-data npm run relay:start                                # prod (built)
```

Operator tasks are the relay CLI (`npm run relay -- <command>`), which operates
directly on `DATA_DIR` — no running server required:

```sh
DATA_DIR=/srv/accord-data npm run relay -- create-invite [--days N]  # print a one-time signup code
DATA_DIR=/srv/accord-data npm run relay -- list-devices              # enrolled devices
DATA_DIR=/srv/accord-data npm run relay -- revoke-device <id>        # revoke a device
DATA_DIR=/srv/accord-data npm run relay -- status                    # accounts / devices / mode
```

On an invite-only relay **every** account needs a code (there is no admin/first
-user bypass) — mint one with `create-invite` and enter it in the app's
onboarding (or hand it to a friend). Existing users can also invite friends from
inside the app (that invite additionally establishes the friendship).

> The legacy passkey web app + its all-in-one server (`npm run dev:server`) still
> exist during the greenfield transition, but the native app is the product and
> the relay above is its backend.

In the app, the **left rail** lists every friend (your DM with them) and every
group, ordered by most recent activity — expand it to see names next to the
icons, and click one to open the chat. Each chat has its own **sidebar**: `#chat`
for the conversation itself, plus notes you **pin** to it, organized into
folders you can nest and drag around. Pinning is private — it doesn't share the
note.

### Voice (v6)

Voice is **end-to-end encrypted** and relayed through a built-in mediasoup SFU
(no second service to run). For calls to connect **off localhost** you must:

1. Set `VOICE_ANNOUNCED_IP` to the public/LAN IP clients can reach this host at.
2. Publish **and** port-forward the RTC range `40000–40100` (UDP, with TCP
   fallback) — the compose file and Dockerfile already declare it.
3. Serve over **HTTPS** (browsers gate microphone access + the encryption API to
   secure origins).

Supported browsers: Chrome, Edge, Safari, Firefox, and Zen (the encryption uses
the standard `RTCRtpScriptTransform`). See [spec/voice.md](spec/voice.md).

### Key transparency (optional full-AKD)

The relay publishes a **key-transparency log** so clients can verify a handle
really maps to the identity key they're shown. Out of the box it runs an
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
the token empty to stay on the interim log. See
[spec/key-transparency.md](spec/key-transparency.md).

## How the encryption works

- On signup the client generates a random 256-bit **master key (MK)**; it never
  leaves the browser unwrapped.
- Each passkey wraps the MK via the WebAuthn **PRF extension** →
  HKDF-SHA-256 → AES-256-GCM. Unlocking = one passkey tap.
- An **optional password** (Argon2id, set in Settings → Security or chosen at
  signup) independently wraps the MK for users whose passkey can't produce PRF
  output or who can't register a passkey at all. It can sign in *and* unlock the
  lock screen ("Unlock with password").
- A **recovery code** (160-bit, shown once) independently wraps the MK and is
  the only fallback if all passkeys and passwords are lost. It can be rotated in
  Settings.
- Each note is encrypted with its own AES-256-GCM key, which is wrapped by the
  MK. Titles, bodies and tags are all inside the ciphertext.
- Notes are cached client-side in IndexedDB **as ciphertext** for instant load
  and offline reading; the unlocked MK is held in session storage and cleared
  by the configurable auto-lock.
- Passkeys must support the PRF extension (recent Chrome/Edge/Firefox/Safari
  with platform authenticators, 1Password, Bitwarden, etc.).

## Running locally

### The native app (v8 — this is the product)

**Dev mode** (hot reload, two terminals):

```sh
npm install
npm run build -w shared                              # build shared types once

# terminal 1 — the relay on :3000 (tsx watch, data in an ABSOLUTE DATA_DIR)
DATA_DIR=$PWD/relay-data npm run relay:dev

# terminal 2 — the native window, frontend served by Vite with HMR
npm run dev:native
```

`dev:native` starts Vite on :5173 and points the native window at it, so **the
whole frontend hot-reloads into the running app** — edit a `.vue`/`.ts` file and
the change lands without a rebuild or restart. Editing anything under
`src-tauri/` triggers an incremental `cargo` rebuild and relaunches the window
(a few seconds); the vault survives, since it lives in the app data dir.

The webview's console output is piped to the terminal running `dev:native`, so
client-side errors show up there — no need to open devtools to catch them.

> **<http://localhost:5173> in a browser is *not* the native app.** The Vite
> server is shared, but `isNative` is false there, so the browser gets the
> **legacy** passkey/server client below — no vault, no local store, no relay
> chat. Every v8 surface is native-only until a v8 web client exists (deferred;
> see [spec/roadmap.md](spec/roadmap.md)). Use the native window to verify v8 work.

**Release build** (installers into `src-tauri/target/release/bundle/`):

```sh
npm run build:native
```

### The legacy web app (being retired)

```sh
# terminal 1 — API on :3000 (tsx watch, SQLite in server/data/)
APP_ORIGIN=http://localhost:5173 npm run dev:server

# terminal 2 — web app on :5173, proxies /api to :3000
npm run dev:web
```

Open <http://localhost:5173>. The first account created becomes the admin.
`APP_ORIGIN` must match the URL in the browser or passkey ceremonies fail —
that's why the API server needs it set to the Vite origin in dev.

**Production-style** (single server, serves the built SPA):

```sh
npm run build
npm start            # http://localhost:3000, data in ./data/
```

Useful checks: `npm run typecheck` (server + web).

**Docker on macOS (Colima):** Docker containers need a Linux kernel, so on a
Mac they run inside a lightweight VM — Colima provides it without Docker
Desktop. One-time setup:

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

Open <http://localhost:3000>. Keep the published port and `APP_ORIGIN` in
agreement (the default origin is `http://localhost:3000`) or passkeys will
refuse to register. Data persists in the `notes-data` volume across rebuilds;
`docker rm -f notes` + the `docker run` again swaps in a new build. Colima is
macOS-only — on the Linux server Docker runs natively (see DEPLOY.md).

Stack: TypeScript everywhere — Fastify + better-sqlite3 + @simplewebauthn
(server); Vue 3 + Pinia + Pinia Colada + Reka UI + Tailwind, built with Vite
(web); WebCrypto for all encryption.

## License

[AGPL-3.0-only](LICENSE). Self-hosting is free; if you run a modified version
as a network service, the AGPL requires you to publish your modifications.
