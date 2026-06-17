# Deploying Notes

How to run this on a real server (Debian assumed, but anything with Docker
works), hook up a domain with HTTPS, and ship new versions.

## 1. First deploy

```sh
# on the server
curl -fsSL https://get.docker.com | sh           # installs docker + compose plugin
git clone git@github.com:jtrobinson1993/notes.git && cd notes
APP_ORIGIN=https://notes.yourdomain.com docker compose up -d --build
```

The repo is private, so the server needs read access. Cleanest option is a
**deploy key**: generate an SSH key on the server (`ssh-keygen -t ed25519`),
then add the public half in GitHub → repo → Settings → Deploy keys
(read-only). Alternatively `gh auth login` works.

All state lives in the `notes-data` Docker volume — the SQLite database,
attachment blobs, and the automatic daily backups. For disaster recovery, add
a cron job that copies that volume (or `DATA_DIR`) somewhere off-machine.
Everything in it is ciphertext, so the copies are E2E-encrypted by
construction.

## 2. Domain + HTTPS

DNS is one record: an **A record** for `notes.yourdomain.com` pointing at the
server's public IP (plus AAAA for IPv6 if you have it).

HTTPS is mandatory — passkeys (WebAuthn) refuse to work without it. Put
**Caddy** in front; it obtains and renews Let's Encrypt certificates
automatically. Compose setup:

```yaml
services:
  notes:
    build: .
    restart: unless-stopped
    environment:
      APP_ORIGIN: https://notes.yourdomain.com
    volumes:
      - notes-data:/data
    # no ports: — only Caddy is exposed

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ['80:80', '443:443']
    volumes:
      - caddy-data:/data
    command: caddy reverse-proxy --from notes.yourdomain.com --to notes:3000

volumes:
  notes-data:
  caddy-data:
```

Requirements for Let's Encrypt: ports 80/443 reachable from the internet
(router port-forward if home-hosted) and the DNS record resolving to the
server.

Two things to be deliberate about:

- **Pick the final hostname before anyone registers.** Passkeys are bound to
  the origin; changing the domain later strands every passkey, leaving
  recovery codes as the only way back in.
- **Home server with a changing IP?** Use a dynamic-DNS updater — or skip
  public exposure entirely with **Tailscale**: `tailscale cert` issues a valid
  HTTPS certificate for the machine's tailnet hostname, only people on your
  tailnet can reach the app, and nothing is open to the internet. Great fit
  when only you and invited friends need access.

### Push notifications

Background "new message" push works out of the box once the app is served over
HTTPS (which the Caddy setup above gives you). On first boot the server
generates a VAPID keypair into the data volume (`DATA_DIR/vapid.json`); users
opt in under **Settings → Security → Notifications**. To pin a keypair
explicitly, set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (see `.env.example`).
Notifications are content-free by design — see
[spec/notifications.md](spec/notifications.md).

## 3. Releasing new versions

Simplest loop that works:

```sh
# on your dev machine: develop, test locally, then
git tag v1.1.0 && git push --tags    # tag known-good points for rollback

# on the server
cd notes && git pull && docker compose up -d --build
```

Compose rebuilds the image and swaps the container. The volume — and
therefore all data — is untouched; schema migrations run on boot. Rollback is
`git checkout v1.0.0 && docker compose up -d --build`. Downtime is a few
seconds.

### When pull-and-rebuild gets old: GHCR

Add a GitHub Actions workflow that builds a multi-arch image on every tag and
pushes it to `ghcr.io/jtrobinson1993/notes`. The server's compose file then
uses `image: ghcr.io/jtrobinson1993/notes:latest` instead of `build: .`, and a
release becomes:

```sh
docker compose pull && docker compose up -d
```

(or fully automatic with Watchtower polling the registry). This also moves
the npm install/build cycle off the production box.

**Recommended path:** Caddy compose + manual tag-pull-rebuild now; add the
GHCR workflow when releasing feels repetitive.
