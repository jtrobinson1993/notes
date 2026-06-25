# Security (cross-cutting)

The key/identity model is in [accounts-and-crypto.md](accounts-and-crypto.md);
this file covers application-level security that spans notes and chat.

## Rendering safety — no `v-html`, raw HTML inert

Reading mode (and chat messages) render from marked's **token stream straight to
VNodes** (`MdTokens`) — there is **no `v-html` and no DOMPurify**. Raw HTML in a
note/message renders as **literal text**, except the two inline pairs the editor
itself writes — `<u>` and `<span style="color:…">` with **regex-validated**
values — which are paired and built as real elements. Link/image URLs are
scheme-validated in the renderer. Because there is no HTML parse step, there is
no sanitizer config to get wrong and no mXSS surface; **hostile chat senders get
no script-injection vector by construction.**

## Remote media privacy (click-to-load)

Remote images and YouTube/Vimeo embeds are **click-to-load** placeholders by
default — no request leaves the client until the reader opts in, so a sender (or
note) can't harvest the reader's IP via a hostile image/embed URL. Per-device
Settings → Privacy toggles (`notes:click-load-images`, `notes:click-load-embeds`).
Attachment images are unaffected (local decrypts).

**Chat GIFs (KLIPY).** A GIF chosen from search is embedded in the encrypted
message as a CDN URL (`MessagePayload.gif`), so the recipient loads the animated
media from KLIPY's CDN on display — an accepted third-party metadata leak
(recipient IP/timing to KLIPY, never to our server, which only sees ciphertext).
Because that URL is **sender-controlled**, the recipient's client only renders
GIFs whose media host is `*.klipy.com` over HTTPS (`safeGif` in the chat store);
anything else is dropped, so a hostile sender can't smuggle an arbitrary
tracking URL past the click-to-load model above.

**Link previews (SSRF surface, v3.4).** Previews are **opt-in, off by default**,
and only generated when every chat member has them on. Generating one makes the
**server** fetch a user-supplied URL (`GET /api/og`), so it's guarded against
SSRF: http(s) only; the host must resolve to a **public** IP (loopback, private,
link-local, CGNAT, cloud-metadata `169.254.169.254`, and multicast are blocked
for both IPv4 and IPv6); redirects are followed **manually and re-validated each
hop**; the response is size- and time-capped and must be HTML. The parsed OG
fields are embedded in the **encrypted** message (the server only sees the URL at
proxy time), and the preview image loads via click-to-load. DNS rebinding is
closed at the socket layer: the fetch runs through an undici dispatcher whose
custom lookup re-validates the resolved IP at **connect** time, so a host can't
pass the pre-check with a public record and then connect to a private one.

## Rate limiting

A global per-IP limiter (`@fastify/rate-limit`, registered in `buildApp`) caps
abuse without policing real traffic — the default ceiling is deliberately
**liberal** (`RATE_LIMIT_MAX`, 600 req/min) so normal use is never throttled.
The unauthenticated credential ceremony (register / login / recovery) gets a
**tighter** per-route bucket (~1/10th the global limit, floored at 30/min) since
it's the brute-force surface; that's still ~30 login attempts/min, well above
human use. Over-limit requests get `429`. Tests raise the ceiling out of the way
(`rateLimitMax` in the app builder) so request-heavy suites aren't throttled.

## Content-Security-Policy (v3 phase 3 — as built)

A strict CSP plus companion hardening headers are set on **every** response as
defense-in-depth (`server/src/security-headers.ts`, wired in `buildApp`). Even if
a hostile message somehow injected a `<script>`, the browser refuses to run it.

**Inline scripts are allowed only by hash, never `'unsafe-inline'`.** The built
`index.html` ships exactly one inline script (the pre-paint theme applier that
avoids a flash; the vite-plugin-pwa service-worker registration is an *external*
`/registerSW.js`, covered by `'self'`). At boot the server reads the served
`index.html`, hashes the text of every inline (no-`src`) `<script>` with SHA-256,
and folds `'sha256-…'` into `script-src`. Computing from the bytes on disk means
the policy tracks whatever the build emits; change one character and the hash no
longer matches — which is exactly what stops an injected script. (A hash is the
natural fit for a static file; a per-response nonce suits server-rendered pages.)

The directives:

- `default-src 'self'`, `base-uri 'self'`, `form-action 'self'`, `object-src 'none'`
- `script-src 'self' 'wasm-unsafe-eval' 'sha256-<theme>'` — `'wasm-unsafe-eval'`
  permits compiling/instantiating **WebAssembly**, which the app needs for
  hash-wasm's **Argon2id** (password-based accounts) and the **RNNoise** voice
  denoiser. It is deliberately the WASM-scoped token, **not** `'unsafe-eval'`: JS
  `eval()`/`new Function()` stay blocked, so an injected `<script>` still can't
  run arbitrary code. Without it, browsers reject `WebAssembly.compile()`
  ("Missing 'wasm-unsafe-eval' or 'unsafe-eval'") and password signup/voice
  denoise break.
- `style-src 'self' 'unsafe-inline'` — Vue/reka-ui apply runtime styles via
  injected `<style>`/style attributes; far lower-risk than inline *script*.
- `img-src 'self' blob: data: https:` — `'self'` for the emoji proxy, `blob:`/
  `data:` for decrypted attachments/avatars. `https:` is required because the
  browser loads two image classes **cross-origin straight from source**: KLIPY
  GIF-CDN images and **click-to-load** OG preview images (arbitrary hosts). This
  is a deliberate relaxation — image loads can't execute code, and click-to-load
  + no-referrer bound the privacy cost (see below). Tightening it would mean
  proxying every preview image through our origin (a product change, not free).
- `connect-src 'self' wss://<host>` — REST + the chat WebSocket. The `ws(s)`
  origin is named explicitly because `'self'` is inconsistent for sockets across
  browsers.
- `worker-src 'self'`, `manifest-src 'self'` — the service worker + PWA manifest.
- `media-src 'self' blob:`, `font-src 'self' data:`.
- `frame-src 'none'`, `frame-ancestors 'none'` — we embed nothing and refuse to
  be embedded (clickjacking).
- `upgrade-insecure-requests` on https origins.

Companion headers (also every response): `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer` (keeps our URLs out of the cross-origin GIF/OG
image loads), `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Resource-Policy: same-origin`, a locked-down `Permissions-Policy`,
and `Strict-Transport-Security` on https.

## Threat model & metadata exposure

The design target is **"a curious or compromised server/host operator can't read
content."** E2EE delivers that. Metadata hiding defends a *different* threat (an
operator learning who-talks-to-whom-and-when); on a self-hosted instance the
operator is usually the trusted party, which is why metadata is an accepted
tradeoff. Relevant if instances are run by **someone other than their users**
(shared hosting) — the friend-invite codes are opaque/ephemeral for exactly this
reason (see [chat.md](chat.md)).

What's practical to encrypt later (cheap wins): per-user read/unread state (an
encrypted synced blob, like tag colors); display names (distributed E2E to
friends); sender identity (sealed-sender). What's structurally visible to the
routing/storing server and **not** worth hand-rolling around: the social graph /
conversation membership, message timing and size, and the friend-code → account
lookup. Hiding those needs mixnets / PIR / enclaves — out of scope.

## Untrusted server vs. malicious host (the served-code limit)

"The server can't read content" is precise about **data**. It's worth separating
two adversaries — they have different ceilings:

- **A curious / compromised / shady host reading what's stored** (DB, disk,
  backups, RAM, the network) sees only ciphertext and **public** keys. It cannot
  read notes or messages, and it cannot unwrap the master key: the
  PRF / recovery-code / seal material that unwraps MK never reaches the server.
  Device linking is the same — the relay stores the new device's *public* key and
  the *sealed* MK; unsealing needs a private key the server never holds (see
  [accounts-and-crypto.md](accounts-and-crypto.md)).

- **A malicious host tampering _live_** can try to substitute keys mid-flow
  (e.g. swap the device-linking public key to seal MK to itself). Such active
  attacks are defended per-protocol by **human verification** — the device-link
  **SAS** is compared on both screens, and a swapped key makes it mismatch.

- **The residual limit — inherent to _all_ browser-delivered E2EE — is that the
  host serves the client.** A malicious host can ship a tampered bundle that
  exfiltrates MK at unlock, or *fakes* a verification step (shows a matching SAS
  while sealing to an attacker key). No protocol detail defeats the host
  controlling the code, and this is a **whole-app** property: a feature like
  device linking adds no exposure a tampered client didn't already have the
  moment you unlock.

**Deployment consequence.** The model is **self-hosting**: you run the box, so
"untrusted server" means untrusted *cloud / network*, not untrusted *you*. For
**multi-tenant / hosting-for-others**, users must trust the served client; raise
that bar with **code transparency** (the public repo — diff served assets against
the published build), **Subresource Integrity / pinned reproducible builds**, and
the **PWA cache** (an installed client resists per-session swapping until it
updates). A **signed native / desktop client** is the strongest answer and is
out of scope today.
