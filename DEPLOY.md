# Deploying Notes

How to run this on a real server (Debian assumed, but anything with Docker
works), hook up a domain with HTTPS, and ship new versions.

The committed `docker-compose.yml` is the production setup: it runs the app
behind **Caddy**, which obtains and renews HTTPS certificates automatically. It
pulls a prebuilt image from GHCR, so the server never compiles anything.

## 1. First deploy

```sh
# on the server
curl -fsSL https://get.docker.com | sh        # installs docker + compose plugin
git clone https://github.com/jtrobinson1993/notes.git && cd notes
cp .env.example .env                           # then edit it (see below)
docker compose up -d
```

Edit `.env` and set at least:

- **`APP_ORIGIN`** — the exact public URL you'll open the app at
  (`https://notes.yourdomain.com`). Passkeys are bound to it and Caddy gets the
  certificate for it. Get this right before anyone registers (see the warning in
  §2).
- **`VOICE_ANNOUNCED_IP`** — only if you want voice: the host's public/LAN IP
  that clients reach it at.

That's the whole deploy. Caddy is already in the compose file, so HTTPS is on by
default — there's nothing to wire up by hand.

**State** lives entirely in the `notes-data` Docker volume — the SQLite
database, attachment blobs, and automatic daily backups. For disaster recovery,
add a cron job copying that volume (or `DATA_DIR`) off-machine. Everything in it
is ciphertext, so the copies are E2E-encrypted by construction.

## 2. Domain + HTTPS

DNS is one record: an **A record** for `notes.yourdomain.com` pointing at the
server's public IP (plus AAAA for IPv6 if you have it).

HTTPS is handled by the bundled Caddy service via Let's Encrypt. Requirements:
ports **80 and 443** reachable from the internet (router port-forward if
home-hosted) and the DNS record resolving to the server. No certificate files,
renewals, or extra config — Caddy reads `APP_ORIGIN` from your `.env` and does
the rest.

Two things to be deliberate about:

- **Pick the final hostname before anyone registers.** Passkeys are bound to the
  origin; changing the domain later strands every passkey, leaving recovery
  codes as the only way back in.
- **Home server with a changing IP?** Use a dynamic-DNS updater. If your domain
  is on **Netlify DNS**, there's a ready-made one in
  [`scripts/netlify-ddns/`](scripts/netlify-ddns/) — a systemd timer that keeps
  your `A` record pointed at the host's current public IP. Otherwise, skip public
  exposure entirely with **Tailscale**: `tailscale cert` issues a valid HTTPS
  certificate for the machine's tailnet hostname, only people on your tailnet can
  reach the app, and nothing is open to the internet. Great fit when only you and
  invited friends need access. (With Tailscale you can drop the Caddy service and
  point the app at the tailnet cert instead.)

### Voice ports

Voice media (mediasoup) is direct UDP/TCP to the host, not proxied by Caddy. The
compose file publishes `40000-40100`; forward that same range on your router and
keep it in sync with `VOICE_RTC_MIN/MAX_PORT` if you change it.

**On Linux, reserve the range from the ephemeral pool.** `40000-40100` falls
inside the kernel's default ephemeral port range (`32768-60999`), so a transient
outbound connection can grab one of those ports just as Docker tries to bind it —
`docker compose up` then fails intermittently with `failed to bind host port
0.0.0.0:400xx: address already in use`. Tell the kernel not to hand those ports
out as ephemeral:

```sh
echo 'net.ipv4.ip_local_reserved_ports = 40000-40100' \
  | sudo tee /etc/sysctl.d/99-notes-voice-ports.conf
sudo sysctl --system
```

(Adjust the range if you change `VOICE_RTC_MIN/MAX_PORT`. Skip it if you don't
use voice.)

### Push notifications

Background "new message" push works out of the box once the app is served over
HTTPS (which the Caddy setup gives you). On first boot the server generates a
VAPID keypair into the data volume (`DATA_DIR/vapid.json`); users opt in under
**Settings → Security → Notifications**. To pin a keypair explicitly, set
`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` in `.env`. Notifications are
content-free by design — see [spec/notifications.md](spec/notifications.md).

## 3. Releasing new versions

Releases are published as prebuilt images by the **Release** GitHub Actions
workflow: tag a known-good commit and it builds a multi-arch image to
`ghcr.io/jtrobinson1993/notes`.

```sh
# on your dev machine: develop, test, then tag the release
git tag v0.2.0 && git push --tags
```

A `vX.Y.Z` git tag publishes `ghcr.io/jtrobinson1993/notes:X.Y.Z` (the `v` is
dropped — Docker convention) plus `:latest`. So `NOTES_TAG` below uses the
unprefixed form, e.g. `0.2.0`.

```sh
# on the server, once the workflow has published the image
cd notes && git pull && docker compose pull && docker compose up -d
```

`git pull` refreshes the compose file; `docker compose pull` grabs the new
image; `up -d` swaps the container. The volume — and all data — is untouched;
schema migrations run on boot. Downtime is a few seconds.

**Rollback** is a one-liner: set `NOTES_TAG=0.1.0` in `.env` and
`docker compose up -d`. No rebuild, since every version is a published image.

> The GHCR image package must be **public** (it is, matching the public repo) so
> the server can `docker compose pull` without authenticating. If you ever make
> it private, run a one-time `docker login ghcr.io` with a read-only PAT on the
> server.

### Building on the server instead

If you'd rather not use the registry (or are hacking on a branch), the compose
file still carries `build: .`, so `docker compose up -d --build` compiles and
runs locally. That's the slower path — it runs the full `npm ci` + build on the
box each release — but needs no published image.

### Fully automatic updates

Point **Watchtower** at the registry to poll and redeploy new images on its own,
if you'd rather not run the release command by hand.
