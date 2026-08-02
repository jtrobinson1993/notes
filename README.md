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
- **Chat.** 1:1 DMs and group chats: text, emoji, encrypted attachments, and —
  in DMs — edit, delete and reactions (the group fan-out for those is a
  follow-up, as are threaded replies). Envelopes are sealed to the recipient — the relay
  sees an opaque blob addressed by a *delivery token*, not a sender. Each chat
  has its own sidebar where you can **pin** notes into nested folders; pinning is
  private and does not share the note.
- **Emoji, without the tracking.** Unicode emoji plus `:shortcode:` emotes with
  a search picker. Emote search and every image go through **your relay**, never
  a third-party CDN, so the emote provider never sees your IP; images you have
  been sent are kept in an encrypted, size-bounded on-device cache, so they keep
  working offline. A message can only pull a small number of new emotes
  (extras stay as `:text:`), which stops anyone using a message full of emotes
  to hammer your relay or fill your disk.
- **Reach is capability-gated.** Someone can only put mail in your mailbox if
  they hold your delivery token, which you hand out by accepting an **invite**
  (`accord://friend?i=…`, minted in-app and shared out of band) — so there is no
  cold-contact path and the relay never stores a friend graph. A group chat is
  the only way to talk to someone who isn't a friend — and being added to one
  only works if the person adding you is **already your friend**, since the
  group's key arrives as ordinary mail that anyone (including the relay) could
  otherwise post. An invite can only ever create a group that is new to you: it
  can never replace the key of a group you're already in, and an attempt to do
  so is refused and raises a non-dismissable alarm.
- **Voice.** 1:1 calls from a DM, relayed through the mediasoup SFU embedded in
  the relay (no peer-to-peer, so no participant learns another's IP). Audio
  frames are end-to-end encrypted and the SFU forwards media it cannot decode.
  It **fails closed**: a webview without WebRTC Encoded Transform cannot place or
  accept a call at all, rather than silently downgrading to plaintext Opus.
- **Key transparency.** The relay publishes a signed, append-only log of
  handle → identity-key bindings. Before trusting a contact's key — when you
  redeem an invite, and when a friend request arrives — the app asks the log
  what key that handle owns and checks the answer against a log root the relay
  has signed. If the log publishes a different key, the contact is **not**
  added, nothing is sent back to them, and you get a non-dismissable alarm.
  If the log cannot answer (relay offline, handle not published yet), the
  contact is added but shown as **"Key not verified"**, and re-checked on every
  reconnect. The app also audits *its own* handle against the log's key history
  and exchanges signed epoch roots with contacts, to catch a relay showing
  different logs to different people. The human out-of-band check (SAS) that
  would make this independent of the relay entirely is still unbuilt.
- **Multiple accounts.** Each account is its own vault (own master key, store and
  relay identity) in its own data directory; switching restarts the app.

### Not built yet

Named here so the feature list above isn't read as more than it is. The full
list, with designs, is [spec/roadmap.md](spec/roadmap.md).

- **Notes are local-only.** No relay sync, no sharing with another user, no
  version history, no collaborative editing.
- **Desktop only.** No iOS/Android shell, and no browser client (deferred
  deliberately — a browser can't hold the Rust core's trust properties).
- **One device per account, and that is load-bearing.** Device pairing and
  history transfer aren't built, and relay-held escrow — the old "log in on a
  new install with handle + password" path — has been removed, because it meant
  storing a password-wrapped master key on the relay forever. So an account
  exists only on the device that created it: there is no log-in screen, and
  **losing that device loses the account itself**, not just the history. There
  is no encrypted backup export yet either. Pairing and that export are the
  planned answers; both are launch-blocking. See
  [spec/security.md](spec/security.md#total-device-loss-is-unrecoverable-by-design).
- **No notifications outside the app.** Unread counts appear in the sidebar and
  the window title; there is no OS notification, no sound, and nothing registers
  for the relay's content-free push wake.
- **Group membership only grows.** Create and add-member work; removing a member
  (with the group-key rotation that must accompany it) and leaving a group don't.
- **GIF search and link previews are relay-side only.** The proxies exist and
  are tested on the relay; nothing in the app calls them yet. (Emoji, the third
  proxied surface, *is* wired up — see below.)
- **SAS fingerprint verification** — the out-of-band way to confirm a contact's
  key without trusting the relay — is specified but unbuilt.
- Builds are **unsigned** for now, so every OS will warn on first launch.

## Running the relay

The relay is the only server. It serves `/api/relay/*` and a health probe — no
web app, no accounts UI — and is administered by a CLI, not a browser.

### Docker (recommended)

Works anywhere Docker runs: Debian/Linux, Windows (Docker Desktop / WSL2), macOS.

Setup runs on **two machines, and which command runs where is the whole
security property**:

| | **Your own machine** | **The server** |
|---|---|---|
| Runs | `init-identity`, and later `rotate-online-key` | the relay itself, and every other CLI command |
| Holds | the **root private key**, in your password manager | the online keypair and the root's *public* key |

Exactly one thing crosses between them: the `relay-identity.json` you copy up.
Nothing comes back, and the root private key never moves.

#### Step 1 — mint the identity **on your own machine**

```sh
npm run relay -- init-identity        # writes ./relay-identity.json, prints a root key ONCE
```

No checkout on your laptop? The published image runs the same command, with no
server and no database involved:

```sh
docker run --rm -v "$PWD:/out" ghcr.io/jtrobinson1993/notes \
  npm run relay -- init-identity --out /out/relay-identity.json
```

It produces two things, and they go to **different places**:

- **`relay-identity.json`** — the root *public* key, the online keypair and the
  signed delegation. This is the file you copy to the server, and the only one.
- **The root private key**, printed to your terminal once. **Put it in your
  password manager before you do anything else** — a secure note in 1Password /
  Bitwarden / `pass`, backed up the way you back up that vault. It is written to
  no file, not even the bundle, so nothing can ever print it again.

> [!WARNING]
> **Do not run `init-identity` on the server, and never copy the root private
> key there.** Nothing will complain if you do: you get a relay that works
> perfectly and a security property that is silently gone, because the key every
> client pins is now in that machine's shell history, terminal scrollback and
> memory — exactly where a break-in reaches. The relay never needs it. Mint the
> identity somewhere the relay cannot be broken into.

#### Step 2 — deploy, on the server

```sh
git clone https://github.com/jtrobinson1993/notes.git && cd notes
cp .env.example .env        # set APP_ORIGIN to the relay's public URL, then:
docker compose up -d --no-start                         # creates the /data volume
docker compose cp relay-identity.json notes:/data/relay-identity.json
docker compose up -d
```

**Neither step is optional** — a relay with no identity refuses to start and
prints the command to run and the path it looked at. But there is **no setup
command to run on the server**: it ingests the bundle at boot, and later restarts
are no-ops. See [*The relay identity*](#the-relay-identity) below for rotation
and for what losing the root key costs.

Compose runs the relay behind **Caddy**, which gets HTTPS certificates
automatically, alongside the optional `akd-sidecar` (see
[key transparency](#key-transparency) below). It pulls a prebuilt image so
nothing compiles on the server. See [DEPLOY.md](DEPLOY.md) for the full
walkthrough (DNS, releases, rollback).

Or a single container without compose (you supply your own TLS):

```sh
docker build -t notes .
docker volume create notes-data
# copy the relay-identity.json you minted above into the volume:
docker run --rm -v notes-data:/data -v "$PWD:/in" notes \
  cp /in/relay-identity.json /data/relay-identity.json
docker run -d --name notes --restart unless-stopped \
  -p 3000:3000 \
  -e APP_ORIGIN=https://relay.example.com \
  -v notes-data:/data \
  notes
```

Then mint an invite (below) and enter it in the app's onboarding. Nothing is
created by opening the URL in a browser — there is nothing to open.

### Serve it over HTTPS

Device tokens, sealed envelopes and KT roots all ride these endpoints, so a real
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
| `APP_ORIGIN` | `http://localhost:3000` | Public URL of the relay (drives HSTS, the Caddy certificate, and the default push subject) |
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

### The relay identity

A relay has two Ed25519 keys, and the split is the point:

- a **root** key — its private half never touches the server. It signs exactly
  one kind of statement: a *delegation* naming the current online key. Its public
  half is what clients pin and what invites carry.
- an **online** key — lives on the relay and signs the key-transparency log,
  continuously, because that has to happen without you.

If the server is broken into, the attacker gets the online key, and you revoke it
with one command. If the two were the same key (as they were before), a break-in
would be unrecoverable: the attacker could sign a forged key directory with the
very key every client trusts, and you could not revoke the anchor using the
anchor.

**So the identity is generated on your machine, never on the relay.**
`init-identity` needs no database, no `DATA_DIR` and no server — run it on a
laptop that has never touched the relay:

```sh
npm run relay -- init-identity        # from a checkout
# no checkout? the image runs the same command:
docker run --rm -v "$PWD:/out" ghcr.io/jtrobinson1993/notes \
  npm run relay -- init-identity --out /out/relay-identity.json
```

It writes **`relay-identity.json`** — the root *public* key, the online keypair,
and the signed delegation — and prints the **root private key once**.

**Store that key in a password manager** — a secure note in 1Password, Bitwarden,
`pass`, or whatever you already trust with a vault, and back it up the same way.
It is not written to any file, not even the bundle, so nothing can print it
again. It must never be copied onto the relay, pasted into `.env`, or handed to
CI: anything the relay can read, a break-in can read.

Then deploy: copy `relay-identity.json` into the relay's `DATA_DIR` and start the
relay. **There is no setup command to run on the server** — it reads the bundle
at boot, installs it, and does nothing on subsequent restarts. Leaving the file
in place is fine and expected (it holds no secret the relay's database doesn't
already hold).

```sh
docker compose cp relay-identity.json notes:/data/relay-identity.json
# or plain: scp relay-identity.json you@relay:/srv/accord-data/
```

You need the root key only to rotate the online key — after a suspected break-in,
or to renew the delegation before it expires (default lifetime one year; the
relay warns in its log from 30 days out and `status` shows the time left). Same
shape: run it on your machine, copy the new bundle over, restart.

```sh
# in the checkout, with the bundle you are replacing; pipe the key in from
# wherever you stored it, so it never lands in a file or your shell history:
pass show accord/relay-root | npm run relay -- rotate-online-key --in relay-identity.json
# or: ACCORD_RELAY_ROOT_KEY="$(pass accord/relay-root)" npm run relay -- rotate-online-key
```

The key is read from stdin or `ACCORD_RELAY_ROOT_KEY` — never a flag, since argv
is visible to every process on the box — and is used to sign one delegation and
dropped. Rotation does **not** change the fingerprint clients pin, so nobody has
to re-register and no one sees a warning: clients accept a newer, root-signed
delegation silently. Both the relay and every client refuse a delegation that
doesn't move the version forward, so a stolen old key cannot be replayed back
into service — clients remember the highest version they have accepted from each
relay, which is what makes the retirement stick even against somebody who
intercepts the connection.

**Losing the root key is not recoverable, and it is worth being concrete about
what that costs.** You keep a working relay until the delegation expires (a year
by default) — but in the meantime you cannot rotate, so if the server is *also*
broken into there is no way to revoke the stolen online key, and no way to renew
before the deadline. The only way back is a new relay identity, which every
client refuses as a substitution: recovery means every user re-pinning, and since
each account's per-relay identity — the key its friends address it by — is
derived from that fingerprint, in practice that means **new accounts and lost
friendships**. Back the key up like a vault recovery kit — it is not in
`DATA_DIR`, so your server backups do not contain it.

### The operator CLI

Day-to-day operator tasks are `npm run relay -- <command>`, which acts directly on
`DATA_DIR` — no running server required. Use an **absolute** `DATA_DIR` so the
CLI and the relay always agree on which database they mean (or set it in `.env`,
which both read).

```sh
DATA_DIR=/srv/accord-data npm run relay -- create-invite [--days N]   # one-time signup code
DATA_DIR=/srv/accord-data npm run relay -- list-devices               # enrolled devices
DATA_DIR=/srv/accord-data npm run relay -- revoke-device <id>         # revoke a device
DATA_DIR=/srv/accord-data npm run relay -- status                     # identity / accounts / devices / mode
DATA_DIR=/srv/accord-data npm run relay -- prune                      # drop expired/used invites
```

(`init-identity` and `rotate-online-key` are the two that *don't* — they run on
your own machine and ignore `DATA_DIR` entirely. See above.)

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

**Contact keys are only *verified* on the AKD log.** The client checks a new
contact's key with an AKD inclusion proof, against a root it has confirmed the
relay signed. On the interim log there is no proof the client can verify, so
contacts on such a relay are added but always read "Key not verified" — another
reason to set the token.

Anyone can audit a relay's log from its public endpoints — `GET
/api/relay/kt/roots` (also at `/.well-known/accord/kt-roots`) — with the
reference auditor. It checks the relay's delegation chain against its root key,
then every epoch root against the online key that root's version names, plus the
hash chain, and alarms on a rewritten epoch or a stalled log:

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
  - under **Argon2id(password)** (m ≈ 19 MiB, t = 2, p = 1) — the fallback when
    the keychain can't be read;
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
- **The relay itself is pinned.** Its published fingerprint must be the hash of
  the **root** key it serves, and it must match what your account is anchored to:
  the fingerprint inside the invite you joined with, or the one recorded on your
  first connection. A relay that presents a different identity is refused, with
  the same alarm as a key-transparency failure, rather than quietly re-trusted.
  Joining by typed address or operator code has no out-of-band fingerprint to
  check against, so that first connection is trust-on-first-use — an invite does
  not have that gap.
- **…and it has to prove which key signs its log.** The pinned root does not sign
  the key-transparency log itself; it signs a short record naming the *online*
  key that does ([above](#the-relay-identity)). Accord verifies that record
  against the pinned root before it will check a single contact key, refuses one
  that is expired or signed by anything else, and remembers its version number so
  a relay can never go back to a signing key the operator retired. An operator
  rotating that key is silent and needs nothing from you; a rotation you did not
  expect, or a record that will not verify, stops the connection and raises the
  banner.
- **Sealed sender.** A message is sealed to the recipient's X25519 key and posted
  with a **delivery token** — a capability derived from the recipient's profile
  key that only their friends hold. The relay checks a hash of the token,
  forwards the opaque envelope, and deletes it on ack. It never learns the
  sender.
- **No key material on the relay, wrapped or otherwise.** The password and the
  recovery code are *local* keys — they unwrap MK from this device's sidecar, and
  no server can check either one. The relay used to hold a password-wrapped copy
  of MK for cold-start recovery; that was removed, because a permanently stored
  blob behind one human-chosen password is an offline brute-force target on a
  server whose whole point is holding nothing worth stealing.
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
cargo test --manifest-path src-tauri/Cargo.toml    # the Rust core + its relay integration tests
npm run build && npm run e2e                       # Playwright against the real relay
npm run e2e:ui                                     # Playwright: the app UI over a faked Tauri IPC
```

`cargo test` runs the core's unit tests **and** the integration tests that drive
two whole core instances against a relay it spawns itself (`node
server/dist/relay-index.js`, throwaway `DATA_DIR`, free port). Those skip with a
printed reason when node/npm are unavailable — `ACCORD_L2_REQUIRE=1` turns a
skip into a failure, which is what CI uses.

`npm run e2e` boots the built relay on a throwaway `DATA_DIR` and drives its HTTP
surface, including real account registration — there is no test-only auth bypass.

`npm run e2e:ui` is the other half: it serves the **real app** (Vite, port 5173)
and drives it in Chromium with a stateful fake of the Rust core injected before
any app script runs, covering the vault gate, the side rail and chat, the
re-lock teardown, and notes. Nothing about the fake ships — it lives in
`e2e/ui/`, and there is no flag that turns it on in a build. See
[spec/testing.md](spec/testing.md) for what it does and does not prove.

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
