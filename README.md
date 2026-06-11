# Notes

Self-hosted, end-to-end encrypted note-taking for a small private group.
Passkey-only sign-in, invite-only registration, Markdown notes with tags and
format-as-you-type editing, note sharing between users, encrypted attachments,
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

## Development

```sh
npm install
npm run build -w shared
npm run dev:server   # API on :3000
npm run dev:web      # Vite on :5173 (proxies /api), set APP_ORIGIN=http://localhost:5173 for the server
npm run typecheck
```

Stack: TypeScript everywhere — Fastify + better-sqlite3 + @simplewebauthn
(server); Vue 3 + Pinia + Pinia Colada + Reka UI + Tailwind, built with Vite
(web); WebCrypto for all encryption.
