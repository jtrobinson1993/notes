# Deploying Notes

How to run this on a real server (Debian assumed, but anything with Docker
works), hook up a domain with HTTPS, and ship new versions.

The committed `docker-compose.yml` is the production setup: it runs the app
behind **Caddy**, which obtains and renews HTTPS certificates automatically. It
pulls a prebuilt image from GHCR, so the server never compiles anything.

## 1. First deploy

### Step 0 — mint the relay identity, **on your own machine**

This is one-time setup you cannot skip: a relay refuses to start without an
identity. It runs on your laptop, not the server, because the key it mints is the
trust anchor every client pins — the relay must never hold its private half. It
needs no database, no `DATA_DIR` and no server.

```sh
# on YOUR machine — from a checkout:
npm run relay -- init-identity
# …or with no checkout at all, straight from the published image:
docker run --rm -v "$PWD:/out" ghcr.io/jtrobinson1993/notes \
  npm run relay -- init-identity --out /out/relay-identity.json
```

It writes **`relay-identity.json`** (the root *public* key, the online keypair
and the signed delegation) and prints the **root private key once**. Put that key
in your password manager before you do anything else — nothing can print it
again, and it is not in the bundle. See
[§4 The relay's identity keys](#4-the-relays-identity-keys).

**Two machines, and the boundary between them is the security property.** The
only thing that crosses it is `relay-identity.json`. If you run `init-identity`
on the server instead — over `ssh`, or "just this once" to save a copy step —
nothing fails, nothing warns, and the property is gone: the root key is now in
that box's shell history, terminal scrollback and process memory, which is
exactly what a break-in gets. The docs are the only thing stopping that, because
the relay itself cannot tell where the bundle it was handed came from.

| Stays on your machine, forever | Goes to the server |
|---|---|
| the **root private key** (password manager) | `relay-identity.json` — root *public* key, online keypair, delegation |
| `init-identity`, `rotate-online-key` | the relay, and every other CLI command |

### Step 1 — the server

```sh
# on the server
curl -fsSL https://get.docker.com | sh        # installs docker + compose plugin
git clone https://github.com/jtrobinson1993/notes.git && cd notes
cp .env.example .env                           # then edit it (see below)
docker compose up -d --no-start                # creates the notes-data volume
docker compose cp relay-identity.json notes:/data/relay-identity.json
docker compose up -d
```

Copy `relay-identity.json` up to the server however you like (`scp`, your
clipboard); the `docker compose cp` above assumes it's sitting in the checkout
directory. **There is no setup command to run on the server** — the relay ingests
the bundle at boot and does nothing with it on later restarts.

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

## 4. The relay's identity keys

Your relay has two Ed25519 keys, and keeping them apart is what makes a break-in
survivable.

| | **Root** | **Online** |
|---|---|---|
| Lives | your password manager, never on the server | on the relay |
| Signs | one thing: a *delegation* naming the online key | the key-transparency log, continuously |
| Clients | **pin** it — it's what an invite carries | trust it only via a valid delegation |
| If the server is breached | untouched | stolen — and you revoke it with one command |

If those were one key (as they were before), a break-in would be terminal: the
attacker could sign a forged key directory with the very key every client trusts,
and you could not revoke the anchor *using* the anchor. Splitting them means a
compromise costs you the online key, not your users' accounts.

That is also why `init-identity` runs on **your** machine and produces a file
rather than doing anything on the server. What lands on the relay —
`relay-identity.json`, and then its database — is the root's **public** key, the
online keypair and the delegation. The root private key is printed once, to your
terminal, and written nowhere. There is no column in the relay's database that
could hold it.

### What "offline root" honestly means here

Worth being straight about, because the shape is borrowed from certificate
authorities and the assurance is not the same. A public CA keeps its root in a
hardware security module, in a safe, under multi-person control, and touches it
in a filmed ceremony. **For a self-hosted Accord relay, "offline" realistically
means a string in your password manager on the same laptop you browse the web
with.** That is what this design assumes, and the tooling is built for it: one
command, a key you paste into a vault, no ceremony.

What that does and does not buy you:

- **It does buy the thing this was built for.** The root key is not reachable
  *from the relay*. Someone who owns the server — the whole box, root, the
  database, the backups — gets the online key and cannot forge a delegation, so
  you can revoke them. That is the difference between "rotate a key" and "every
  account on this relay is gone", and it holds regardless of how humble your key
  custody is.
- **It does not buy CA-grade assurance, and nothing here should be read as
  claiming it does.** Your root key is as safe as your laptop and your password
  manager. Malware on the machine you run `init-identity` and
  `rotate-online-key` on can take it; so can someone with your vault. The threat
  model this defends is *a compromised relay*, not *a compromised operator*.
- **You can raise the bar without changing anything here** if you want to: mint
  the identity on a machine that never goes online, print the key and put it in a
  safe, or split it across two people's vaults. The commands are pure key
  generation and read the key from stdin, so all of those work unchanged. None of
  it is required, and none of it is assumed. What does *not* work today is a
  hardware token that never releases the key: `rotate-online-key` signs the
  delegation in-process, so it needs the key bytes. Supporting a token would mean
  an external-signer mode — not built, and not on the roadmap for a self-hosted
  relay.

### Rotating the online key

Do this if you suspect the server was compromised, or to renew the delegation
before it expires (default lifetime **one year**; the relay warns in its log from
30 days out, and `status` shows the time left).

```sh
# on YOUR machine, in the checkout, with the bundle you are replacing to hand:
pass show accord/relay-root | npm run relay -- rotate-online-key --in relay-identity.json
# or, if your password manager has no CLI:
ACCORD_RELAY_ROOT_KEY="$(pbpaste)" npm run relay -- rotate-online-key --in relay-identity.json
```

The root key is read from stdin or `ACCORD_RELAY_ROOT_KEY` — never a command-line
flag, which would land in your shell history and is visible in `ps` to every
process on the box — and is used to sign one delegation and then dropped. Pipe it
straight out of your password manager rather than parking it in a `root-key.txt`
first; if you do write a file, put it outside the checkout and delete it
afterwards (`.gitignore` covers that name as a backstop, not a plan).

`npm run relay` needs the checkout, so run it there and point `--in` at the
bundle wherever it lives (`--out` defaults to writing over `--in`). Lost the old
bundle? Read `delegation.version` off `GET /api/relay/info` and pass
`--current-version N` instead — rotation refuses to mint a version that doesn't
move forward. Install the result exactly like the first:

```sh
docker compose cp relay-identity.json notes:/data/relay-identity.json
docker compose restart notes
```

The relay installs the new delegation, deletes the previous online private key,
and keeps serving. **The fingerprint clients pin does not change**, so nobody has
to re-register and nobody sees a warning — a client that meets a newer,
root-signed delegation accepts it silently. A superseded delegation can never be
reinstated: the version only ever increases, and the tool, the relay **and every
client** refuse one that doesn't. Clients remember the highest version they have
accepted from your relay and refuse anything older with a hard alarm, which is
what makes a rotation an actual revocation rather than a request.

Two things follow from that, worth knowing before you rotate:

- **Your users' clients only learn about the rotation when they next connect.**
  Until then their floor is the old version, so a rotation protects them going
  forward, not retroactively. There is nothing to do about it — just don't treat
  a rotation as instantly universal.
- **Never install an older bundle.** Restoring `relay-identity.json` from a
  backup taken before a rotation would serve a superseded delegation and set off
  a `relay-delegation-rollback` alarm on every client that has seen the newer
  one. The relay won't let that happen — it logs a warning, ignores the stale
  bundle and keeps serving the newer delegation from its database — but don't
  rely on that: keep only the current bundle, and if you restore `DATA_DIR` from
  a backup, copy the current bundle back over whatever was in it.

Check where you stand any time with:

```sh
docker compose exec notes node server/dist/relay-cli.js status
```

### After a suspected server compromise

Rotating is **step three, not step one**. A fresh online key handed to a machine
the attacker still controls is stolen the same day, and you will have burned a
version number for nothing.

1. **Cut the relay off.** Stop the container, or take the host off the network.
   Clients queue locally and nothing is lost by the relay being down; everything
   users can read is already on their own devices.
2. **Rebuild the host**, not just the container — from the OS up, and not from a
   snapshot taken after the break-in. Restore `DATA_DIR` from a backup you trust
   (it is ciphertext, public keys and hashes; there is nothing in it the attacker
   learns by having had it). **Do not start over with an empty `DATA_DIR`** —
   that discards every account and the whole transparency log, which is a worse
   outcome than the compromise.
3. **Rotate the online key** (above), on your machine, with the root key. This is
   the step that actually revokes what they took: the new delegation supersedes
   the old one, the relay NULLs the stolen key's private half on install, and no
   client will accept the old version again.
4. **Audit devices** — `relay -- list-devices`, and `revoke-device <id>` anything
   you don't recognise. Revocation is immediate: it kills live tokens, not just
   the next challenge.
5. **Run the auditor against your own log**, from a checkout on your machine
   rather than on the relay: `npm run kt-audit -- https://relay.example.com`. It
   verifies the delegation chain under your root and every epoch root under the
   key its `keyVersion` names, and reports a rewritten history. Do it before and
   after the rebuild so you can compare. It proves less than a stranger running
   it would — an auditor that takes the root key from the relay it is auditing is
   checking a document against its own letterhead
   ([spec/key-transparency.md](spec/key-transparency.md#roots-endpoint-public-unauthenticated))
   — but a rewrite it catches is real.

**Be honest with your users about the window.** While they held the online key,
the attacker could sign key-directory roots — the concrete attack is swapping a
contact's public key for one of their own, so messages meant for that contact get
sealed to a key they hold. They could not read anything already stored (the relay
holds ciphertext and never the keys), and they could not forge a delegation. Two
residual limits are worth stating rather than glossing:

- **Roots the stolen key signed stay verifiable at their own version.** Each root
  records the key version that signed it so that a rotation doesn't invalidate
  history, which also means an attacker who kept the old key can still produce
  something a client accepts as a v1-signed root — they just can't be current,
  and, having lost the server, they'd have to beat TLS to deliver it. Tracked in
  [spec/roadmap.md](spec/roadmap.md#online-key-revocation-is-forward-looking-and-only-for-clients-that-saw-it).
- **There is no "re-verify my contacts" button yet.** Short-authentication-string
  comparison is specified and unbuilt
  ([spec/key-transparency.md](spec/key-transparency.md)), so if you believe keys
  were substituted during the window, the only real check is people confirming
  fingerprints with each other out of band.

### If you lose the root private key

There is no recovery, and this is a deliberate tradeoff rather than an oversight.
Your relay keeps working normally until the delegation expires; after that,
clients refuse it and everyone must move to a new relay. The alternative —
delegations that never expire — would mean a delegation whose root key someone
*else* now holds is honored forever, which is precisely the failure this design
exists to bound.

Back up the root private key the way you would a password-manager vault. It is
not in `DATA_DIR`, so **your server backups do not contain it**.

### Never do this

- **Don't copy the root private key onto the relay.** It defeats the entire
  split. Nothing on the server asks for it, and nothing needs it to run.
- **Don't commit `relay-identity.json`.** It's gitignored; it carries the online
  private key.
- **Don't re-run `init-identity` to "fix" a relay.** It mints a *new root*, which
  every client has pinned — they would all see a relay-identity alarm and have to
  re-register. It refuses to overwrite an existing bundle for that reason. To
  replace the online key, rotate.
