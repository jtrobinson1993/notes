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
by construction.** This is now the app's *primary* XSS defence rather than one of
two — see [§ CSP](#hardening-headers-and-the-csp-the-app-does-not-have).

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
**capability** — a 132-bit HMAC over the emote id, keyed by a secret derived from
the relay's pinned identity key, compared with `timingSafeEqual`. Only the authed
search endpoint mints those URLs, so a stranger can't turn the relay into a
general 7TV mirror even though 7TV ids are public. A valid device token is
accepted as an alternative so the native core can fetch an image without a search
round-trip. The capability secret is *derived from* the identity key (never the
key itself) and is stable across restarts, so minted URLs and the year-long
browser cache entry survive a relay restart.

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

**Client side: not wired up yet.** No client surface calls these proxies today —
there is no GIF picker, nothing fetches `/api/relay/og`, and the emote registry
(`web/src/lib/emoji/index.ts`) is populated by nothing, so only unicode emoji
render. Two *client-side* properties that used to exist must come back with the
UI, and are recorded here so they aren't lost:

- A GIF URL is **sender-controlled** and travels inside the encrypted message. The
  recipient must render only GIFs whose media host belongs to the provider's CDN
  over HTTPS — the old `safeGif` allowlist, deleted with the legacy chat store —
  otherwise a hostile sender can smuggle an arbitrary tracking URL past
  click-to-load.
- Emote images must load **only from the relay origin** (or `blob:`/`data:`).
  `registerEmote()` documents that rule but does not enforce it; whatever
  populates the registry has to.

See [roadmap.md](roadmap.md) for the emoji/GIF client work itself.

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
- `POST /api/relay/escrow/kdf` — 10/min, `POST /api/relay/escrow/fetch` — 5/min.
  The escrow blobs are offline brute-force targets, so this is the tightest
  bucket in the relay.
- The content proxies, expressed as **fractions of the operator's ceiling** so a
  relay tuned up or down scales them with it: GIF and emote search 1/10 (60/min
  at the default), `/og` 1/20 (30/min — the SSRF surface), the emote image
  endpoint at the full ceiling (it's cached and cheap).

Over-limit requests get `429`. Tests raise the ceiling out of the way
(`rateLimitMax` in the app builder) so request-heavy suites aren't throttled.

## Hardening headers, and the CSP the app does not have

**On the relay** (`server/src/security-headers.ts`, wired in `buildRelayApp`),
every response carries: `X-Content-Type-Options: nosniff`, `Referrer-Policy:
no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Resource-Policy: same-origin`, a locked-down `Permissions-Policy`,
and `Strict-Transport-Security` on https. CORP is `same-origin` by default and
can only be relaxed by an **explicit per-route decision** — the emote image
endpoint is the one route that does, since it must be loadable as an `<img>` from
the app.

A CSP header is emitted too, but be honest about what it buys now: the relay is
**API-only**. It serves JSON, an image endpoint and WebSockets — never an HTML
document — so `registerSecurityHeaders` is called with `indexHtml = null`, no
inline-script hashes are ever computed, and no browser applies the policy to a
page. Several directives (`worker-src`, `manifest-src`, the YouTube/Vimeo
`frame-src`) are vestiges of the era when this process served the SPA. The header
is kept as a cheap default for any future HTML surface; it is not a live defence.

**The native webview enforces no CSP at all.** `src-tauri/tauri.conf.json` sets
`"csp": null`, and `web/index.html` carries no `<meta>` policy, so the app's own
document runs with no script-source restriction. The old claim — "even if a
hostile message injected a `<script>`, the browser refuses to run it" — is **no
longer true of the shipping client**. What actually holds the line is the
renderer above: there is no HTML parse step, so there is no injection path to
begin with. That is a real property, but it is now a single layer, and the
consequence of losing it is larger in the native shell than it was in the browser
(a script that did run would have the Tauri IPC surface in reach).

Setting a CSP for the webview is **unbuilt hardening**, not a considered
tradeoff — nothing in the code or history records a decision to run without one.
It needs care (bundled assets, `blob:`/`data:` media, mediasoup's WebRTC, WASM
for Argon2id) and should be verified against a running app rather than
guessed, so it belongs in [roadmap.md](roadmap.md) rather than being asserted
here.

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
  recovery-code / seal material that unwraps MK never reaches the relay. Escrow
  is the same — the relay holds MK *wrapped* under secrets it never sees (see
  [accounts-and-crypto.md](accounts-and-crypto.md)).
- **A malicious operator tampering _live_** can try to substitute keys mid-flow
  (e.g. swap a device's public key so a sealed payload lands on its own key).
  Active attacks of that kind are defended by the **KT log** plus **human
  verification** — with the caveat below that SAS comparison is specified but not
  yet built.

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
  tokens), signed group-state records, invites (token *hashes*), and **escrow
  blobs** — MK wrapped under password/recovery secrets the relay never sees, the
  same "can't unwrap MK" property as device linking above (the domain-separated
  fetch auth-key can't unwrap the payload).
- **Transient:** per-device mailbox envelopes (opaque; deleted on ack, ~30-day
  TTL) and attachment blob chunks (deleted when all recipients ack, TTL-capped).
- **Never stored:** plaintext or post-ack ciphertext, **sender identity on any
  envelope**, the friendship graph (verifiers are per-recipient, not per-edge),
  profile contents, read state, raw tokens, and voice media (the SFU forwards
  sealed frames and writes nothing).

**Improvements over the v1–v7 server:** sender identity is hidden
(`/api/relay/mailbox/send` is sessionless — the sender proves knowledge of the
recipient's delivery token and nothing else), content is not retained after
delivery, and read state never reaches the relay. **What remains structurally
visible** to a curious/compromised operator: message *timing and size*; group
membership; a recipient's *device count*; and — because delivery rides plain
HTTPS — the **sender's IP** at send time, a network-position correlate of the
social graph that sealed-sender does *not* erase (mitigated only by the operator
not logging, or users fronting with a VPN/Tor — not by protocol).

### v8 trust boundaries worth stating plainly

Five places where the design accepts a bounded risk rather than eliminating it.
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
- **Escrow is an explicit carve-out from zero-at-rest.** The relay holds the
  password- and recovery-wrapped MK. Zero-at-rest means zero *content* at rest;
  key blobs encrypted under secrets only the user holds are not the honeypot the
  posture exists to avoid. The residual is an **offline brute-force against the
  password-wrapped blob**, bounded by Argon2id (m≈19 MiB, t=2), the 16-character
  minimum, and the 5/min fetch bucket above. See
  [accounts-and-crypto.md](accounts-and-crypto.md#account-escrow--cold-start).
- **History backfill can be *incomplete*, not forged.** Per-message sender
  signatures mean a member serving history cannot alter what someone else said,
  but it **can omit** messages. Not fully preventable; mitigated by preferring
  the owner's or multiple devices as backfill sources.
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
