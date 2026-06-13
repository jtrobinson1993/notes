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

## Content-Security-Policy (lands with chat, phase 3)

A CSP response header as defense-in-depth: roughly `script-src 'self'` (only our
bundled JS) and `frame-src` limited to the embed hosts. Even if a hostile message
somehow injected a `<script>`, the browser refuses to run it.

`script-src 'self'` blocks **inline** scripts — but `index.html` has exactly one
(the pre-paint theme applier that avoids a flash). We allow that one script by
its **hash**: compute the SHA-256 of its exact text, base64 it, and add
`script-src 'self' 'sha256-…'`. The browser runs the inline script only if the
hash matches; change one character and it won't run — which is what stops an
injected script. The hash is computed at build (Vite can emit it); a per-response
**nonce** suits server-rendered pages, but a hash is the natural fit for a static
file. Net: every inline script blocked except our one known-good theme script.

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
