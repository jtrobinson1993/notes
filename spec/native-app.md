# The native app (v8) — shell, vault & onboarding

> **Status: as built.** The v8 client is a **Tauri v2** desktop app — and the
> **only** client: a Rust core that owns all keys, storage and networking, with
> the Vue app as its webview UI. The legacy passkey-authenticated browser SPA
> and its all-in-one Fastify server are **deleted**, not deprecated; a
> stripped-down browser client is future work
> ([roadmap.md](roadmap.md#d16--a-v8-web-client-deferred)). This file covers the
> *shell* — framework choice, the vault gate, onboarding, multi-account, and
> distribution. The data model lives in [local-store.md](local-store.md), the
> wire protocol in [relay.md](relay.md), and the key hierarchy in
> [accounts-and-crypto.md](accounts-and-crypto.md).

## Why native at all

Durable data lives **encrypted on the user's own devices**, so the app needs the
real filesystem. Browser storage is quota-limited and *evictable* (Safari/iOS
evict non-installed web-app data after ~7 days; every engine evicts under storage
pressure), which a full local history plus media cannot tolerate. A **signed,
store-distributed native app** is also the strongest available answer to "is this
client trustworthy" — far better than server-delivered JS, which can be swapped
per-user.

## Framework — Tauri v2 (decided)

One shell stack across all five target platforms (Windows, macOS, Linux, iOS,
Android) reusing the **one** Vue + CodeMirror web codebase. Tiny binaries (~5 MB)
against Electron's ~150 MB / 200–400 MB RAM, which was the deciding factor
against the alternative (Capacitor for mobile + Electron for desktop).

- **The passkey objection is defused by design.** Tauri's WebAuthn/PRF support is
  worst-in-class (effectively broken on Linux), but v8 moves local unlock to the
  **OS keychain**, so PRF is never load-bearing — and with the browser client
  gone there is no passkey ceremony anywhere in the product. See
  [accounts-and-crypto.md](accounts-and-crypto.md). (Gating the keychain read
  behind a *biometric* prompt is not built — the read is silent today. It lands
  with the platform ACL work in [roadmap.md](roadmap.md).)
- **The Linux WebKit render gate passed.** The one blocking risk was whether
  Linux WebKitGTK could render the CodeMirror editor acceptably, since the editor
  conceals Markdown markers as **atomic** ranges and caret motion across them
  depends on layout geometry. Driving the real editor in Linux WebKit vs Linux
  Chromium gave **identical caret-offset motion** and correct live-preview
  rendering. (A font-weight discrepancy in the Chromium reference traced to the
  headless container's minimal font set, not an engine difference.) The harness
  is reusable — see [testing.md](testing.md#the-webkit-editor-harness).
- **Fallback if a later blocker appears:** Capacitor + Electron, still one web
  codebase behind two native shells.

### The development loop

`npm run dev:native` (`tauri dev`) starts Vite on :5173 and points the native
window at it rather than at built assets, so **the frontend hot-reloads into the
running native app** — no rebuild, no relaunch, and the unlocked vault survives
the reload. Changes under `src-tauri/` trigger an incremental `cargo` rebuild and
relaunch the window instead. The webview's console output is piped to the
`dev:native` terminal, so client errors are visible without devtools.

The frontend is therefore iterated **in the native shell**, not in a browser —
there is no longer a browser build to iterate against. Loading :5173 in a plain
browser gets a dead shell: `NativeGate` calls `vault_status` on mount, the
`invoke()` bridge does not exist outside the Tauri origin, so the gate never
leaves `checking` and the app sits on "Unlocking…" forever. Nothing behind the
gate is reachable, by construction. Two consequences worth stating:

- **v8 UI has no browser-drivable form**, so the Playwright suite in `e2e/`
  drives the **relay's HTTP surface** — health, the pinned-identity handshake on
  `/api/relay/info`, the real sessionless register → challenge → signed-nonce →
  token flow, and an SFU join by two independent peers — never the app's UI.
  Automated coverage of native surfaces would need either a dev-only fake of the
  79 IPC commands or a real driver; neither exists, and a fake would have to be
  strictly dev-gated (in a shipped build it would be a vault-gate bypass). The
  old `E2E_TEST_AUTH` seam that minted a session with no ceremony is **deleted**
  along with the server that hosted it — see [testing.md](testing.md).
- **The exception is editor work**, which is browser-testable by design: the
  harness in `web/dev/` mounts the real `<MarkdownEditor>` with no auth or
  stores. See [testing.md](testing.md#the-webkit-editor-harness).

## The Rust core is the client

The core is a **headless client**, not a storage plugin. It owns:

- the **master key (MK)** and every derived/wrapped key,
- the **SQLCipher store** and the encrypted blob files,
- **all relay networking** (auth, mailbox, blobs, directory/KT, group state),
- **all crypto** (sealing, signing, envelope open/seal).

The webview is UI only. **Keys never cross the IPC boundary** — the webview asks
for operations (`relay_send`, `envelope_open`, `attachment_fetch`) and receives
results, never key material. This is the property a browser client fundamentally
cannot have, and the reason a future web client would be a lower-trust tier
rather than a second first-class shell
([roadmap.md](roadmap.md#d16--a-v8-web-client-deferred)).

`web/src/lib/native.ts` is the typed wrapper around every `invoke()`. `isNative`
(Tauri's `isTauri()`) survives as a **guard, not a branch**: there is no second
implementation behind it any more, so the few modules that still check it simply
no-op or render nothing when the bundle is loaded outside Tauri. Everything else
calls the Rust core unconditionally.

## The vault gate

`NativeGate.vue` wraps `<RouterView>` and owns the unlock wall. It renders the
app only in `ready`; every other state replaces the whole app with the wall.
There is **no bypass** — native is the only shell, so the wall always applies.
Gate state (`lib/nativeVault.ts`) is one of:

| State | What it is |
|---|---|
| `checking` | Boot probe (`vault_status`) in flight — shows "Unlocking…". |
| `setup` | First run — no vault exists. Splash → Sign up / Log in / Recover explainer. |
| `recovery` | The one-time recovery code, shown after create and confirmed before continuing. |
| `locked` | A vault exists but is locked. Silent keychain attempt first, then password / recovery code. |
| `onboarding` | Unlocked, but this device has no relay account yet (no `identity.handle` + `relay.url`). |
| `ready` | Unlocked and onboarded — the app renders. |

There is no session store, no login page and no router auth guard: the router
only restores the last visited route (`last-route`). Everything that used to
gate on "logged in" now gates on the vault being unlocked — and `App.vue` drops
every decrypted thing (notes, profile, friends, folder/tag names, a live call)
whenever the gate leaves `ready`, so plaintext never outlives the master key.

Toasts are mounted **outside** the gate, so a failure raised before unlock is
still visible — see [ui.md](ui.md#toasts--the-error-catalogue).

### Unlock paths

Three ways to open the vault, all local and offline (no network):

1. **OS keychain (primary).** The vault key sits in the platform secure store
   (`keyring` crate — macOS Keychain, Windows Credential Manager, Linux Secret
   Service), entries namespaced `name@sha256(dataDir)[..8]` so accounts don't
   collide. Attempted silently on every launch.
2. **Password (portable fallback).** Argon2id (m=19 MiB, t=2, p=1 — the OWASP
   baseline), enforced 16-character minimum at the gate.
3. **Recovery code (break-glass).** 160-bit base32, 8×4 groups, normalized on
   input; shown exactly once at creation and confirmed.

MK **rests only wrapped** — under the keychain vault key, under Argon2id(password)
and under KDF(recovery code) — in a `vault.meta.json` sidecar. The SQLCipher key
itself is random and lives in the keychain, never derived from the password.
Consequence by design: **copying the DB file to another machine yields an
unreadable file**; a new device pairs or restores from escrow.

### Idle re-lock (per device)

Settings → Security → **Require unlock**. Two settings, stored in the encrypted
vault DB (so the policy is per device, and only readable while unlocked):

- `relock.policy` — `stay` (default) | `on-idle`
- `relock.idleMinutes` — default 15

The idle timer resets on pointer/key/wheel activity and tears down on lock.
Shared gate state lives in `nativeVault.ts` (not the component) so any code path
can flip the wall. OS device-lock detection (macOS lock notifications, mobile
lifecycle) is a per-platform follow-up — see [roadmap.md](roadmap.md).

Locking the vault is what the shell calls **Sign out** — there is no server
session to end, so re-locking *is* the local-first equivalent. Two controls call
the same `lockVault()`: **Sign out** in the side rail, and **Lock now** in
Settings → Security. `lockVault` stops the JS mail listener before locking
(draining needs the MK-derived sealing key, so a drain against a locked vault
could only fail).

## Onboarding

Runs after unlock and before `ready`, because a fresh vault has no relay account
yet. The launch is **greenfield** — there is no migration from the legacy app,
so the native shell needed its own account-creation path.

The first-run splash offers exactly two paths, plus an explainer:

- **Sign up** — pick a generated `Word#1234` **handle** from candidates
  (re-rollable; never typed, so the word is always vetted), set the vault
  password, save the one-time recovery code, then set a **display name**
  (required; E2EE, visible only to contacts). The gate then moves to
  `onboarding`, which claims that handle on a relay: paste a friend's invite, or
  give a relay address plus an operator registration code (blank for a public
  relay). A pasted string that doesn't parse as a friend invite is treated as a
  registration code and pre-fills the relay-address form rather than erroring.
- **Log in** — an existing account, on a device with **no** vault: restore from
  the relay-held escrow with relay address + handle + **account password**. This
  is password-only today; the recovery code is the unlock path for a vault that
  already exists on this device, not an escrow-fetch key. Restore rebuilds
  **identity only** — it writes `relay.url` + `identity.handle` and goes straight
  to `ready`, skipping onboarding. Note and message history are *not* recovered
  this way; history lives on devices, and device pairing / backup import are
  unbuilt ([roadmap.md](roadmap.md)).
- **"Can't sign in? Recover account"** is an **explainer, not a flow**: it states
  plainly that Accord holds no email or personal information, so there is no
  "email me a reset" and nobody — including the operator — can recover an account
  for you. The only ways back are the recovery code or the password on a device
  that still holds the vault.

A relay declares its **registration mode** on `/api/relay/info`: `public` or
`invite`-only (`RELAY_REGISTRATION_MODE`, default invite). In invite mode the
invite both gates signup **and** carries the friend request, so redeeming one
makes you friends on the account's first authenticated call. The reference
deployment runs invite-only.

> Historical note, kept because it shaped the design: a built app once failed
> onboarding with a `JSON Parse error` because the legacy session store's
> *relative* `/api/meta` and `/api/me` calls resolved against the Tauri asset
> server and returned HTML. The fix at the time was to keep the legacy session
> flow out of the native path; the legacy stack has since been deleted outright,
> so **every** network call now goes through the Rust core against an absolute
> relay URL, and the client has no relative-`/api` surface left to trip over.

## Multi-account

Each account is a **fully separate vault** — its own MK, device key, encrypted
store, relay identity and data directory. A registry (`accounts.json`) tracks the
accounts and which is active; `account_list` / `account_add` / `account_switch` /
`account_set_label` manage it, and accounts are labelled with their handle after
onboarding or a handle change.

- **Switching restarts the app** so the new account gets fresh relay and
  live-delivery tasks — single-session by design.
- **The first account keeps using the app data dir directly**, so an existing
  single-account install is preserved in place (its keychain namespace doesn't
  move).

## Account surfaces

- **Settings → Security** — the re-lock policy above, plus **Lock now**.
- **Settings → Profile → Change handle** — claims a new generated `Word#1234`
  via device-authed `POST /api/relay/handle` and refreshes the KT root, then
  relabels the account in the switcher. The directory is user-keyed so keys don't
  move, and friends are identity-keyed so friendships are unaffected. No password
  re-auth: **the unlocked vault is the credential**.
- **Switch account** — the account switcher above, reached from the **side rail**
  (not Settings), since switching restarts the app rather than changing a
  setting.

The rest of Settings (Profile, Appearance, Privacy, Voice, Import & export) is
in [ui.md](ui.md#settings).

## Distribution & signing — phased, unsigned-first (decided)

For the initial small-group testing, ship **unsigned and free** and accept the
friction; buy signing identities only when going wider. On **desktop** signing
only removes scary warnings; on **mobile** it is **mandatory to install at all**.
One Apple Developer Program ($99/yr) covers both macOS notarization *and* iOS.

- **Phase 1 — unsigned/free.** Android: sideload via `adb install` (debug builds
  are auto-signed with a free debug key). macOS: right-click → Open past
  Gatekeeper. Windows: SmartScreen → "Run anyway". Linux: AppImage/`.deb` run
  directly. ⚠ If you use a release keystore on Android, **keep it** — updates must
  be signed with the same key.
- **Phase 2 — desktop signing** (only when going past the friend group): macOS
  notarization, Windows Azure Trusted Signing or an OV/EV cert, Linux GPG
  signature + SHA-256 checksums.
- **Phase 3 — iOS last** (paid; a free Apple ID yields only 7-day self-signed
  builds for your own device). Distribute Ad Hoc (≤100 UDIDs/yr) or TestFlight.

**Reproducible builds** — so anyone can verify the shipped binary matches public
source — are part of the trust story and are **not built yet**. The
**mobile shell (iOS + Android) is likewise not built yet**; launch is
desktop-first. Both are tracked in [roadmap.md](roadmap.md).
