# Notes

Self-hosted, end-to-end encrypted note-taking for a small private group.
Passkey-only sign-in, invite-only registration, Markdown notes with tags and
an Obsidian-style live-preview editor (concealed markup, formatting shortcuts,
colors, spoilers, syntax-highlighted code blocks, click-to-load video embeds),
note sharing between users, encrypted attachments,
version history, offline editing with conflict handling, import/export, and an
installable PWA with an encrypted offline cache. The server only ever stores
ciphertext — it cannot read your notes. See [SPEC.md](SPEC.md) for design details.

## Install (Docker)

Works anywhere Docker runs: Debian/Linux, Windows (Docker Desktop / WSL2), macOS.

```sh
git clone git@github.com:jtrobinson1993/notes.git && cd notes
APP_ORIGIN=https://notes.example.com docker compose up -d --build
```

Or without compose:

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
(fine for trying it out) or **HTTPS**. For a server on your LAN or the
internet, put the app behind a reverse proxy with TLS, e.g. Caddy:

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
| `APP_NAME` | `Notes` | Display name |
| `BACKUP_INTERVAL_HOURS` | `24` | Periodic SQLite backup interval (0 disables) |
| `BACKUP_KEEP` | `14` | Number of backups to retain |

All state lives in `DATA_DIR` — back up that one directory (it only contains
encrypted notes and public keys).

## How the encryption works

- On signup the client generates a random 256-bit **master key (MK)**; it never
  leaves the browser unwrapped.
- Each passkey wraps the MK via the WebAuthn **PRF extension** →
  HKDF-SHA-256 → AES-256-GCM. Unlocking = one passkey tap.
- A **recovery code** (160-bit, shown once) independently wraps the MK and is
  the only fallback if all passkeys are lost. It can be rotated in Settings.
- Each note is encrypted with its own AES-256-GCM key, which is wrapped by the
  MK. Titles, bodies and tags are all inside the ciphertext.
- Notes are cached client-side in IndexedDB **as ciphertext** for instant load
  and offline reading; the unlocked MK is held in session storage and cleared
  by the configurable auto-lock.
- Passkeys must support the PRF extension (recent Chrome/Edge/Firefox/Safari
  with platform authenticators, 1Password, Bitwarden, etc.).

## Running locally

**Dev mode** (hot reload, two terminals):

```sh
npm install
npm run build -w shared                              # build shared types once

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
