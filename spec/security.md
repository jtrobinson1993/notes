# Security (cross-cutting)

The key/identity model is in [accounts-and-crypto.md](accounts-and-crypto.md);
this file covers application-level security that spans notes, chat and voice.

**Scope as of v8.** There is exactly one client — the native Tauri app
([native-app.md](native-app.md)) — and exactly one server — the relay
([relay.md](relay.md)). The browser SPA is gone, and with it everything that was
defended *around* it: there is no passkey/WebAuthn login, no server session or
session cookie, no CSRF surface, no browser-side note cache, and no admin UI
(operator tasks are the relay CLI). Authentication to the relay is a **device
token** derived from the device key; the local gate is the **vault unlock**.
A stripped-down browser client may be rebuilt later — see
[roadmap.md](roadmap.md#d16--a-v8-web-client-deferred).

## Rendering safety — no `v-html`, raw HTML inert

Reading mode and chat messages render from marked's **token stream straight to
VNodes** (`MdTokens.ts`) — there is **no `v-html` and no DOMPurify**. Raw HTML in
a note/message renders as **literal text**, except the two inline pairs the
editor itself writes — `<u>` and `<span style="color:…">` with
**regex-validated** values — which are paired and built as real elements.
Link/image URLs are scheme-validated in the renderer (`https?:`/`mailto:`/`tel:`).
Because there is no HTML parse step, there is no sanitizer config to get wrong
and no mXSS surface; **a hostile message sender gets no script-injection vector
by construction.** This is the app's *primary* XSS defence; the webview's CSP is
the second layer behind it — see
[§ Hardening headers and the webview CSP](#hardening-headers-and-the-webview-csp).

## Remote media privacy (click-to-load)

Remote images and YouTube/Vimeo embeds are **click-to-load** placeholders by
default — no request leaves the client until the reader opts in, so a sender (or
note) can't harvest the reader's IP via a hostile image/embed URL. Per-device
Settings → Privacy toggles (`notes:click-load-images`, `notes:click-load-embeds`
in `web/src/lib/privacy.ts`). Attachment images are unaffected — they decrypt
locally to a `blob:` URL and never hit the network.

## The relay content proxies

Three surfaces need third-party content: GIF search (Klipy), link previews (Open
Graph), and 7TV emotes. All three live on the **relay**
(`server/src/routes/relayContent.ts`) for one reason: **the client's IP must
never reach Klipy, 7TV, or an arbitrary link target.** The relay makes the
outbound request and returns normalized data — or, for emote images, bytes from
its own origin. The relay only ever sees a search term or a URL at proxy time;
everything the user actually says stays E2E-encrypted.

**Auth.** `/api/relay/gifs/*`, `/api/relay/og` and `/api/relay/emotes/search` are
gated on the **device bearer token**, like the rest of the relay API. An
unauthenticated `/og` in particular would be SSRF-as-a-service, and an
unauthenticated GIF proxy burns the operator's Klipy quota.
`/api/relay/emote/:sig/:file` (the image) has to work as an `<img src>` and so
cannot carry an `Authorization` header; it is instead gated on an unguessable
**capability** — a 132-bit HMAC over the emote id, keyed by a relay-local secret,
compared with `timingSafeEqual`. Only the authed search endpoint mints those
URLs, so a stranger can't turn the relay into a general 7TV mirror even though
7TV ids are public. A valid device token is accepted as an alternative so the
native core can fetch an image without a search round-trip. That secret is a
random key of its own in `relay_local_secrets`, deliberately **not** derived from
any signing key: it must be stable across restarts *and* across an online-key
rotation, so minted URLs and the year-long browser cache entry survive both, and
no signing key doubles as an HMAC key.

**Link previews are the SSRF surface** (`server/src/linkPreview.ts` +
`ssrf.ts`). Guarded in two layers, both required:

1. **`assertPublicHost()`** — a pre-check on the URL's hostname: http(s) only;
   internal-only suffixes (`localhost`, `.local`, `.internal`, `.home.arpa`,
   `.in-addr.arpa`, `.ip6.arpa`) are refused without touching DNS; every resolved
   address must be a public, routable IP. Blocked ranges cover IPv4 (this-net,
   loopback, RFC1918, link-local incl. the cloud-metadata `169.254.169.254`,
   CGNAT, the TEST-NETs, benchmarking, multicast/reserved) and IPv6 (loopback,
   unspecified, unique-local, link-local, multicast) — **including IPv4 smuggled
   through transition formats**: IPv4-mapped `::ffff:`, NAT64 `64:ff9b::/96`,
   6to4 `2002::/16` and the deprecated `::a.b.c.d`. An IPv6 literal that doesn't
   parse is refused rather than allowed.
2. **`publicOnlyLookup`**, installed as the undici Agent's connect-time DNS hook
   (`ssrfSafeAgent`), so **the IP the socket actually connects to is
   re-validated**. This is the authoritative guard: it closes the DNS-rebinding
   TOCTOU where a host passes the pre-check with a public record and then
   resolves to `127.0.0.1` for the real request. TLS SNI is preserved, so HTTPS
   still works.

On top of that: redirects are followed **manually and re-validated at the top of
every hop** (max 4, and the redirect URL is length-capped); the response must be
`text/html`/`application/xhtml`; the body is capped at **512 KB** (declared
`content-length` *and* streamed bytes); each hop gets 6 s and the **whole chain**
gets a 10 s budget, so N redirects can't stretch into N × the per-hop timeout.
The parsed OG fields are embedded in the **encrypted** message, and the preview
image is subject to click-to-load. Entity decoding is single-pass, so `&amp;lt;`
decodes to the literal `&lt;` rather than double-unescaping.

**Emote fetching** can only ever target 7TV: the id must match the 26-char
Crockford-ULID allowlist and the URL is built from a fixed CDN template, so this
can never become an open proxy. The cache path is additionally contained by
`resolve()`-and-compare (defense-in-depth against path traversal), images must be
`image/*` and ≤ 1 MB, and the on-disk cache has a soft ceiling of 4000 files with
oldest-first eviction so a client walking the 7TV catalogue can't fill the
relay's disk.

**Klipy** never receives our identifiers: the API key stays server-side, and the
per-user analytics id handed to Klipy is `sha256("klipy:" + userId)` truncated to
16 hex chars. Failures are logged without the query — search terms are user
content.

**Client side: emoji are wired end to end; GIFs and OG are not.** The Rust core calls
both emote endpoints — proxied search plus an image fetch that feeds the
size-bounded on-device used-emoji cache
([local-store.md](local-store.md#emoji-on-device-the-used-emoji-cache)). Three
properties it enforces are security-relevant, not housekeeping:

- **The relay may not choose the image origin.** A search result's `url` is
  accepted only as a site-relative `/api/relay/emote/<sig>/<id>.webp` naming the
  emote being described, then re-joined onto the pinned relay base. Rendering a
  relay-supplied absolute URL would hand a hostile relay the IP leak the proxy
  exists to prevent.
- **The 1 MiB image cap is re-enforced against the streamed body**, not a
  declared `content-length`, and the response must be `image/*`. The relay's own
  cap is not trusted with this device's disk or memory.
- **Cached emote bytes are encrypted at rest** under a fresh per-file key with
  the key in the SQLCipher row, and their **filenames are blinded** —
  `SHA-256(salt ‖ id)` under a random per-vault salt, because a 7TV id is a
  public name and a directory listing would otherwise enumerate every emote the
  device has been sent. The set of emotes a device holds is a fingerprint of
  what it has been sent.

Two of those properties have a **client-side other half**, and both are now
enforced in `web/` rather than described
([chat.md](chat.md#emoji-emotes-the-picker-and-the-cap)):

- A **per-message cap on distinct emote fetches** (20). Without it a hostile
  sender puts hundreds of distinct emote refs in one message and every
  recipient fetches every one, turning each recipient into a fetch amplifier
  against the relay. The core cannot enforce this — it has no message context —
  so it reports whether a given `emote_get` hit the network (`fetched`) and the
  shared renderer counts, keyed by message id in module state so re-rendering
  or scrolling back cannot reset the budget. Over-cap shortcodes render as
  literal text; a failed fetch still spends its charge.
- Emote images load **only from the relay origin** (or `blob:`/`data:`/
  same-origin). `registerEmote()` used to document that rule without checking
  it; `isAllowedEmoteUrl()` now enforces it against the origin pinned from
  `relay_status()` at unlock, and a refused registration degrades to literal
  text. Both sides of the IPC boundary check it: the core so a hostile relay
  cannot smuggle a CDN URL through `emote_search`, the webview because it is the
  process that actually creates the `<img>`.

Still owed by the **GIF** client, which does not exist: a GIF URL is
**sender-controlled** and travels inside the encrypted message, so the recipient
must render only GIFs whose media host belongs to the provider's CDN over HTTPS
— the old `safeGif` allowlist, deleted with the legacy chat store — otherwise a
hostile sender can smuggle an arbitrary tracking URL past click-to-load. Nothing
fetches `/api/relay/og` either. See [roadmap.md](roadmap.md).

## Voice fails closed

A voice call that cannot be frame-encrypted is **refused**, not downgraded to
plaintext Opus. The relay's SFU never seeing decodable audio is the premise of
the feature, and the previous silent degrade was indistinguishable from a normal
call. Both fail-open layers are closed (the transform helpers throw instead of
no-op'ing; the app's media layer always passes them) and the two entry points
that put audio on the wire are gated, with a `VOICE_E2EE_UNSUPPORTED` toast and
an automatic decline so the caller isn't left ringing. Ending a call is never
gated. Full detail:
[voice.md](voice.md#fail-closed-no-call-without-frame-e2ee).

## Rate limiting

A global per-IP limiter (`@fastify/rate-limit`, registered in `buildRelayApp`)
caps abuse without policing real traffic — the default ceiling is deliberately
**liberal** (`RATE_LIMIT_MAX`, 600 req/min). Tighter per-route buckets sit on top
wherever a route is expensive, makes an outbound request, or could act as a
guessing oracle:

- `POST /api/relay/register` — 20/min (the account-creation surface).
- `POST /api/relay/invites/check` — 30/min (non-consuming validity oracle).
- The content proxies, expressed as **fractions of the operator's ceiling** so a
  relay tuned up or down scales them with it: GIF and emote search 1/10 (60/min
  at the default), `/og` 1/20 (30/min — the SSRF surface), the emote image
  endpoint at the full ceiling (it's cached and cheap).

Over-limit requests get `429`. Tests raise the ceiling out of the way
(`rateLimitMax` in the app builder) so request-heavy suites aren't throttled.

**Every route states its own bucket, even when that bucket is just the global
ceiling.** The remaining relay routes carry a `DEFAULT_RATE` option that restates
`rateLimitMax` verbatim — the same number the global limiter already applied, so
it changed no behaviour. Two reasons it is written out rather than left implicit:

- *Readable.* "Is this endpoint limited, and how much?" is answerable from the
  route, not from remembering a plugin registration in `relay-app.ts`.
- *Checkable.* CodeQL's `js/missing-rate-limiting` models per-route config and
  the `@fastify/rate-limit` import, but **not** `register(plugin, { global:
  true })`, so 13 genuinely-limited routes were reported as unlimited. The fix
  was to state the limit where the analyzer (and a reader) looks, not to silence
  the rule.

For the same reason the per-route helper returns the limit and the caller writes
the `{ config: { rateLimit: … } }` nesting inline: the analyzer matches that
nesting by *local* dataflow from the route's options argument and does not step
through a function return, so folding the `rateLimit` key inside a helper made
the content proxies read as unlimited despite being the most tightly limited
routes on the relay.

## Hardening headers and the webview CSP

**On the relay** (`server/src/security-headers.ts`, wired in `buildRelayApp`),
every response carries: `X-Content-Type-Options: nosniff`, `Referrer-Policy:
no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Resource-Policy: same-origin`, a locked-down `Permissions-Policy`,
and `Strict-Transport-Security` on https. CORP is `same-origin` by default and
can only be relaxed by an **explicit per-route decision** — the emote image
endpoint is the one route that does, so it can be loaded as an `<img>` from
another origin.

The relay's own CSP is deliberately minimal — `default-src 'none'; base-uri
'none'; form-action 'none'; frame-ancestors 'none'` — because the relay is
**API-only**: JSON, an image endpoint and WebSockets, never an HTML document, so
no browser ever applies it to a page. It is a floor in case this process ever
does emit HTML, not a live defence. The SPA-era directives it used to carry
(script/style/img/font/connect sources, `worker-src`, `manifest-src`, a
YouTube/Vimeo `frame-src`) and the `inlineScriptHashes` machinery behind them
were deleted: a dead header that *reads* like a defence is worse than a short
one.

### The native webview's CSP

The policy that actually defends the app lives in `src-tauri/tauri.conf.json`
(`app.security.csp`), and Tauri sends it as a `Content-Security-Policy` response
header on the bundled `index.html` — from the `tauri://localhost` origin on
macOS/Linux and `http://tauri.localhost` on Windows, so `'self'` means "the
bundle" on every platform. As shipped:

```
default-src 'none';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https:;
font-src 'self';
media-src 'self' blob:;
connect-src ipc: http://ipc.localhost;
worker-src 'self';
frame-src https://www.youtube-nocookie.com https://player.vimeo.com;
object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

Keys living in Rust means an XSS cannot steal them directly, but it *can* drive
every IPC command the UI can reach, so the policy is written to deny by default
and name each resource type the app genuinely loads:

| Directive | Why exactly this |
|---|---|
| `script-src 'self'` | No `'unsafe-inline'`, no `'unsafe-eval'`. `index.html`'s one inline script (the pre-paint theme applier) is allowed by **hash**: Tauri's codegen sha256s every inline `<script>` in the bundled HTML and appends it to `script-src` at runtime, so the configured value stays clean and a *different* inline script still can't run. No `'wasm-unsafe-eval'` — no WebAssembly runs in the webview at all (Argon2id lives in the Rust core; `hash-wasm` is reachable only from tests and is not in the bundle). |
| `style-src 'self' 'unsafe-inline'` | The one relaxation. CodeMirror's theme is injected at runtime as a `<style>` element by `style-mod` — dynamic text, so no hash can cover it — and blocking it doesn't throw, it silently renders the editor unstyled. Inline **styles** cannot execute script, and the only user-controlled CSS value in the app is the `<span style="color:…">` pair, restricted by `COLOR_VALUE_RE` to a brand var or a `light-dark(#hex, #hex)` pair. *Rejected:* `EditorView.cspNonce` + Tauri's `__TAURI_STYLE_NONCE__` placeholder would allow a nonce instead, but it depends on a Tauri-internal token in `index.html`, diverges from dev (where Vite injects styles inline anyway), and the failure mode of getting it wrong is an unstyled editor in a release build. |
| `img-src 'self' data: blob: https:` | `data:` for avatars, `blob:` for decrypted attachments and for emote bytes handed over from the core. `https:` covers the two loads that do leave the machine: the **click-to-load remote image** in a note or message (`![](https://…)`), and the **emote picker's** relay-hosted search thumbnails. Both are discussed below; `http:` is deliberately not allowed. |
| `media-src 'self' blob:` | Audio/video attachments decrypt in the core and play from object URLs. |
| `font-src 'self'` | Geist/Geist Mono are bundled (`@fontsource-variable`); no CDN, so no `data:` and no remote origin. |
| `connect-src ipc: http://ipc.localhost` | **The webview may not open a network connection at all.** Both entries are `invoke()`'s own transport (`ipc://localhost` on macOS/Linux, `http://ipc.localhost` on Windows/Android — Tauri's IPC `fetch`es the custom protocol and falls back to `postMessage` if CSP blocks it). There is no `fetch`, `XMLHttpRequest` or `WebSocket` anywhere in `web/src`: all relay traffic is the Rust core's. The CSP turns that architectural rule into something the engine enforces. mediasoup's WebRTC is unaffected — `RTCPeerConnection` is not governed by CSP. |
| `worker-src 'self'` | The E2EE voice frame-crypto Worker (`lib/voiceFrameWorker.ts`, a module worker built into `assets/`). No `blob:` — nothing constructs a worker from an object URL. |
| `frame-src` (two origins) | The click-to-load video embeds the editor writes, exactly the origins `web/src/lib/editor/media.ts::embedSrc` produces (`youtube-nocookie.com`, `player.vimeo.com`). |
| `object-src`/`base-uri`/`form-action`/`frame-ancestors` `'none'` | Plugins, `<base>` rewriting, and form posts have no legitimate use here; every `<form>` in the app is `@submit.prevent`. |

#### The relay origin is never named — and mostly isn't needed

The relay's URL is **chosen by the user**, so it cannot be a build-time constant,
and Tauri's CSP is static configuration: there is no supported API to change a
window's policy after it is created. Three ways out were considered.

1. **Template the CSP per account at runtime.** Would mean patching Tauri or
   recreating the webview whenever the relay changes. Rejected.
2. **Name a wildcard that covers any relay.** `https:` covers an https relay but
   not a self-hosted one on plain http, so it doesn't actually solve "unknown
   origin" — it just widens the policy. Rejected as the *primary* answer.
3. **Route remote media through the Rust core**, which already holds the device
   token and owns all networking: it fetches the bytes and hands them over IPC,
   and the UI renders a `blob:`. **Chosen**, and already how the built core
   works — `emote_get` returns image bytes from the on-device cache or, on a
   miss, from the relay's image proxy
   ([local-store.md](local-store.md#emoji-on-device-the-used-emoji-cache)). So
   the emotes that arrive **in content** — the ones a hostile sender controls,
   and the ones that must render offline — never put the relay origin in the
   document at all.

The one deliberate exception is the **emote picker**: search results are
browsing, not content, so the core returns the relay's capability paths and the
picker is meant to render them directly rather than pulling every thumbnail
through IPC and past the cache. Those loads ride the `https:` source below. A
plain-http relay therefore gets no picker thumbnails (everything else, content
emotes included, still works) — allowing `http:` in `img-src` to fix that would
be a worse trade than the missing thumbnails.

#### What the policy does not close

`img-src … https:` leaves a one-way exfiltration channel: script running in the
webview could encode data into an image URL on any https host. Two shipped
things need it — the **click-to-load remote image** in a note or message
([§ Remote media privacy](#remote-media-privacy-click-to-load)), and the emote
picker's relay-hosted thumbnails above — and removing it would break both
silently. Note the shape of what is left, though: `connect-src` allows no origin
at all, so there is no read-back channel; an attacker gets blind `GET`s, not a
request/response loop, and no way to read a reply.

Closing it means routing those two through the core as well, at which point
`https:` leaves `img-src` and the webview has no route to the network whatsoever.
That is tracked in
[roadmap.md](roadmap.md#tighten-img-src-by-fetching-remote-images-in-the-core).

#### Dev, and how the policy is verified

Under `npm run dev:native` the webview loads the **Vite dev server**, not the
bundle, so Tauri never touches the document and `app.security.devCsp` alone would
apply to nothing. Vite therefore sends the policy itself (`server.headers` in
`web/vite.config.ts`, built by `web/csp.ts`), reading `devCsp` from
`tauri.conf.json` so there is one source of truth and adding the same inline-script
hash Tauri computes for the bundle. `devCsp` is identical to the shipped policy
except for `connect-src`, which also allows `'self'` and `ws://localhost:5173`
for HMR. (A `vite --host` LAN session reaches the page from a different origin,
so HMR's socket is refused there and the page needs a manual reload — deliberate,
rather than allowing `ws:` wholesale.)

Because a too-tight CSP fails **silently** — no crash, just a missing avatar,
attachment, worker or stylesheet — the policy is checked against real engines
rather than by reading it: `node web/dev/csp-probe.mjs` (and `--dev`) loads the
app under the exact shipped header in **Chromium and WebKit** and reports every
violation, covering `data:`/`blob:` images, `blob:` media, the module worker,
runtime-injected styles, inline style attributes, the bundled fonts, and the
editor harness with real CodeMirror. The policy's invariants — no inline script,
no network origin in `connect-src`, `frame-src` matching `embedSrc`, dev
differing from prod only in `connect-src` — are asserted in
`web/test/lib/csp.test.ts`.

## Threat model & metadata exposure

The design target is **"a curious or compromised relay operator can't read
content."** E2EE delivers that. Metadata hiding defends a *different* threat (an
operator learning who-talks-to-whom-and-when); the v8 relay narrows that
considerably (below) but does not eliminate it.

What is **structurally visible** to the routing relay and **not** worth
hand-rolling around: message timing and size, group membership (the relay fans
out per the signed group-state record), a recipient's device count, and the
sender's IP at send time. Hiding those needs mixnets / PIR / enclaves — out of
scope, and listed as a non-goal in [roadmap.md](roadmap.md#non-goals).

### Untrusted server vs. malicious host

"The relay can't read content" is precise about **data**. Two adversaries with
different ceilings:

- **A curious / compromised / shady operator reading what's stored** (DB, disk,
  backups, RAM, the network) sees only ciphertext and **public** keys. It cannot
  read notes or messages, and it cannot unwrap the master key: the password /
  recovery-code / seal material that unwraps MK never reaches the relay. Since
  relay-held escrow was [removed](roadmap.md#escrow--removed) it holds no wrapped
  key material at all — there is nothing on the server an offline attack could be
  mounted against (see
  [accounts-and-crypto.md](accounts-and-crypto.md)).
- **A malicious operator tampering _live_** can try to substitute keys mid-flow
  (e.g. swap a device's public key so a sealed payload lands on its own key).
  Active attacks of that kind are defended by the **KT log** plus **human
  verification** — with the caveat below that SAS comparison is specified but not
  yet built. The log defends nothing on its own unless the *relay's* identity is
  anchored: the pinned root is what every KT root signature ultimately traces
  back to, so the client refuses a relay whose fingerprint does not bind the root
  key it serves, whose identity differs from the invite/pin it is anchored to, or
  which cannot show a current, root-signed delegation naming the online key that
  signed those roots ([relay.md](relay.md#pinning-the-relay-identity-as-built)).

#### What a relay-server compromise costs (changed 2026-08-02)

The most consequential trust boundary in the system moved, and it is worth
stating as a before/after rather than leaving it implicit in the relay spec.

| | **Before** (one relay key) | **Now** (offline root + online key) |
|---|---|---|
| What the attacker gets from owning the server | the key clients **pin** | the **online** signing key only |
| Can they sign forged KT roots? | yes | yes, while they hold the server |
| Can the operator revoke it? | **no** — you cannot revoke the anchor *with* the anchor | yes: one root-signed delegation at `version + 1`, which the attacker cannot forge |
| What clients must do to recover | re-pin a new identity = new accounts, lost friendships | nothing; a newer valid delegation is accepted silently |
| Net cost of a breach | the identity of every account on the relay | one signing key, and the window before rotation |

The reason this is possible at all is that the two jobs the old key did have
different custody requirements. Signing a KT root has to happen unattended on
every directory change, so *that* key must sit on the server. Being the anchor
requires the opposite: never being reachable from the thing it vouches for. The
split gives each job the custody it needs — the root signs exactly one kind of
statement, a delegation naming the current online key, and its private half is
generated on the operator's machine and never exists on the relay
([relay.md](relay.md#relay-identity-an-offline-root-and-an-online-signing-key)).

What the split does **not** change: an attacker holding the server can still
forge directory entries and sign roots over them for as long as they hold it, so
this bounds *recovery*, not *exposure*. Two residuals are recorded rather than
hidden — a revoked key still validates roots stamped with its own version, and a
client that never saw the rotation still has the old floor
([roadmap.md](roadmap.md#online-key-revocation-is-forward-looking-and-only-for-clients-that-saw-it)).
And the guarantee is only as good as the operator's custody of the root key: for
a self-hosted relay that realistically means a password manager, not a hardware
security module, which [DEPLOY.md](../DEPLOY.md) says plainly rather than
implying certificate-authority-grade assurance.

**What changed with the native client.** The old residual limit — inherent to all
browser-delivered E2EE — was that *the host serves the client*, so a malicious
host could ship a tampered bundle that exfiltrates MK at unlock. That no longer
applies: the app is an installed binary whose frontend assets are bundled
(`frontendDist`), the relay serves no code, and switching relays cannot change
the code you run. Key handling and storage live in the Rust core, not in
webview-delivered script.

The trust problem is not gone, it has **moved to distribution**: you must trust
the binary you installed and its update channel. Raising that bar is
**code transparency** (the public repo), **reproducible builds**, and **signed
releases with a verifiable update channel** — none of which are built yet; see
[roadmap.md](roadmap.md#signing--reproducible-builds). Until they are, "install
from a source you trust" is doing real work in this model.

## v8 relay — retention & metadata posture (as built)

v8 replaces the content-storing server with a **zero-at-rest relay**: it holds
ciphertext only until a device acks delivery and never learns message senders
(sealed-sender). The authoritative, exhaustive list of what it persists is the
state inventory in [relay.md](relay.md) — nothing may be added there without
updating this section too. In summary:

- **Durable, and why it's safe:** the key directory + KT log (public keys only),
  device *public* keys, **delivery-token verifiers** (`hash(token)`, never the
  tokens), signed group-state records, invites (token *hashes*), and the relay's
  own identity — the **public** half of its offline root plus every online
  keypair that root has delegated to. No wrapped user key material: relay-held
  escrow is [gone](roadmap.md#escrow--removed), and the root private key never
  existed here.
- **Transient:** per-device mailbox envelopes (opaque; deleted on ack, ~30-day
  TTL) and attachment blob chunks (deleted when all recipients ack, TTL-capped).
- **Never stored:** plaintext or post-ack ciphertext, **sender identity on any
  envelope**, the friendship graph (verifiers are per-recipient, not per-edge),
  profile contents, read state, raw tokens, voice media (the SFU forwards sealed
  frames and writes nothing), and the relay's **root private key** — which is not
  merely absent but has no place to be: it is generated on the operator's machine
  and no schema column, bundle field or serving-path module can hold or mint one
  ([relay.md](relay.md#never-stored)).

**Improvements over the v1–v7 server:** sender identity is hidden
(`/api/relay/mailbox/send` is sessionless — the sender proves knowledge of the
recipient's delivery token and nothing else), content is not retained after
delivery, and read state never reaches the relay. **What remains structurally
visible** to a curious/compromised operator: message *timing and size*; group
membership; a recipient's *device count*; and — because delivery rides plain
HTTPS — the **sender's IP** at send time, a network-position correlate of the
social graph that sealed-sender does *not* erase (mitigated only by the operator
not logging, or users fronting with a VPN/Tor — not by protocol).

### Total device loss is unrecoverable, by design

**Decided 2026-07-27.** If a user loses every device they own and holds no
exported backup, their account is gone: not only the message and note history,
but the **identity itself** — the handle, the contacts who address them by
identity key, and the ability to prove they are the same person to anyone.
Nothing anywhere can restore it. This is a constraint the product accepts, not a
defect to be fixed later, and it is written here so it is never treated as one.

**Why.** Everything durable is encrypted under a master key (MK) that exists only
on the user's own devices. That is the property the whole design is built to
deliver: the relay stores no content at rest, cannot read what it forwards, and
holds nothing that could reconstruct an account. Any recovery mechanism that
works *without* a surviving device requires something recoverable to exist
somewhere the user is not — which is exactly the thing the threat model rules
out. **Relay-held escrow was that mechanism and has been removed** (see
[roadmap.md](roadmap.md#escrow--removed)): it put a permanently stored,
password-wrapped MK on the server, creating an offline brute-force target against
a single human-chosen password and a standing at-rest liability, in exchange for
a convenience that device pairing already provides whenever any device survives.

**What this means in practice.** There are exactly two ways to not lose
everything, and both require acting *before* the loss:

1. **Own more than one device.** Pairing makes every device a full replica
   ([roadmap.md](roadmap.md#multi-device-history--sync-d8a)), so any surviving
   device restores both identity and history to a replacement.
2. **Keep an encrypted backup export** somewhere the user controls
   ([roadmap.md](roadmap.md#offline-encrypted-backup-export-d8)). This is the
   only protection against losing *all* devices at once — theft, fire, a single
   laptop being the whole fleet.

The recovery code does **not** cover this case and must never be presented as
though it does: it wraps MK *locally*, so it dies with the device it was created
on. It protects against a forgotten password, not a lost device.

**Obligation on the interface.** Because the failure is silent until it is
absolute, onboarding has to say so plainly and push the two mitigations —
the ≥2-device nudge and the backup export — rather than burying them in settings.
A user who discovers this constraint at the moment they need recovery has been
failed by the product, even though the cryptography behaved exactly as designed.

### v8 trust boundaries worth stating plainly

Seven places where the design accepts a bounded risk rather than eliminating it.
Each is deliberate; none should be discovered by surprise later.

- **Sealed sender is partial against an *actively correlating* relay.** It
  removes the explicit, logged sender field — strong against casual logging, a
  log subpoena, and an honest-but-curious operator. But the sender's device uses
  the **same IP** for its authenticated fetch session and its sealed send, so
  A→B can still be inferred by IP correlation. True sender anonymity needs
  network-layer decoupling (Tor/mixnet) and is out of scope.
- **The relay is trusted for message *order*.** It stamps arrival time, so it
  could reorder or backdate. Impact is bounded — content is authenticated,
  replies embed a snapshot of their context, and a relay can already withhold or
  delay delivery — but nothing may treat relay ordering as adversary-proof. See
  [local-store.md](local-store.md#message-ordering-no-server-counter).
- **Losing every device loses the account — permanently.** *(Decided
  2026-07-27; this is an accepted design constraint, not a gap.)* See
  [Total device loss](#total-device-loss-is-unrecoverable-by-design) below.
- **History backfill can be *incomplete*, not forged.** Per-message sender
  signatures mean a member serving history cannot alter what someone else said,
  but it **can omit** messages. Not fully preventable; mitigated by preferring
  the owner's or multiple devices as backfill sources.
- **A relay reached without an invite is trust-on-first-use.** The client pins
  the relay's identity — the fingerprint must bind the identity key the relay
  serves, and a later change is refused with a hard alarm
  ([relay.md](relay.md#pinning-the-relay-identity-as-built)) — but the *first*
  connection needs an anchor from outside the relay. A friend invite carries one
  (`relayFp`, out-of-band through the human invite channel); typing a relay
  address or pasting an operator registration code does not. So a relay that is
  hostile from the very first connect is pinned as itself. This matters because
  the pinned key is the **root** of the chain every key-transparency root
  signature is verified through — root → delegation → online key
  ([relay.md](relay.md#relay-identity-an-offline-root-and-an-online-signing-key)).
  Roadmap: put the fingerprint in operator codes too.
- **Group *membership* is the relay's copy of a record the client cannot yet
  diff.** Who may hand you a group *key* is enforced — an invite is admitted only
  from a current friend the KT log does not contradict, and can never re-key a
  group you are already in ([chat.md](chat.md#who-may-hand-me-a-group-key)). But
  `group_add_member` re-signs the group-state record the relay returns, and with
  no locally mirrored previous version it cannot see a member spliced into it.
  A spliced identity gets fan-out ciphertext and blob reach, never the group key
  or any content. Roadmap:
  [mirror the record](roadmap.md#group-state-is-trusted-from-the-relay).
- **A voice call is authorized by possession of its call id**, not by
  friendship — the relay hides the social graph and so cannot check one. The id
  is 192 random bits delivered only inside a sealed offer, and a stranger holding
  one still cannot hear anything (frames are sealed under a key that rode inside
  that envelope). See [voice.md](voice.md#security--privacy).

**Key-transparency caveat:** SAS fingerprint verification — the
server-trust-free anchor that covers a young relay before a gossip/auditor
ecosystem exists — is **specified but not built**
([key-transparency.md](key-transparency.md#bootstrap-honesty)). Until it ships,
MITM defence rests on the KT log plus gossip alone.
