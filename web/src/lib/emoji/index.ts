// Named image emotes (":shortcode:" → image URL).
//
// The bundled 7TV manifest is gone: emote images come from the relay's proxying
// emote endpoints (it fetches them, so no client ever talks to a third-party CDN
// and leaks its IP). Two things populate this registry, and nothing else should:
//
//  - the **picker** (`EmojiPicker.vue`), with the relay-absolute capability URLs
//    `emote_search` returns and the ids of the offline cached set — browsing,
//    never persisted;
//  - the **shared content renderer** (`render.ts`), with `blob:` URLs minted
//    from bytes the core handed over, which *is* the cache-writing path.
//
// A registration is only accepted if its URL is one this app minted or the
// pinned relay's own origin — see `registerEmote`.

interface Registered {
  /** CONTENT-renderable URL: a `blob:` minted from bytes the core has cached.
   *  Empty until this emote has actually been pulled through `emote_get`. */
  url: string;
  /** 7TV id, when known — what `emote_get(id, name)` needs. */
  id?: string;
  /** BROWSING-only URL for a picker tile (the relay's own image endpoint).
   *  Never satisfies content rendering — see `registerEmotePreview`. */
  preview?: string;
}

const emotes = new Map<string, Registered>();

// The connected relay's origin (`https://relay.example`), from `relay_status`.
// Null until the app learns it, which means "no remote origin is acceptable
// yet" — fail closed rather than trusting whatever a caller passes.
let relayOrigin: string | null = null;

/** Pin the origin remote emote URLs must match. Pass the relay's base URL
 *  (`relay_status().base_url`), or null on lock / disconnect. */
export function setEmoteRelayOrigin(baseUrl: string | null): void {
  if (!baseUrl) {
    relayOrigin = null;
    return;
  }
  try {
    relayOrigin = new URL(baseUrl).origin;
  } catch {
    relayOrigin = null;
  }
}

/** The currently pinned relay origin (null when not connected). */
export function emoteRelayOrigin(): string | null {
  return relayOrigin;
}

/**
 * True when `url` is one this app is allowed to render an emote from:
 *
 *  - `blob:` / `data:` — bytes this app already holds (the content renderer
 *    mints these from `emote_get`), so there is no request to leak;
 *  - same-origin — the app bundle itself;
 *  - an absolute URL on the **pinned relay origin** — the proxy that exists so
 *    the device never resolves a third-party CDN host.
 *
 * Anything else is refused. This is the check `registerEmote`'s doc comment used
 * to merely *claim*: without it, one hostile registration (a relay handing back
 * a `cdn.example` link, a note or message body that reaches a registration path)
 * turns every render into an IP-revealing beacon to a host of someone else's
 * choosing.
 */
export function isAllowedEmoteUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme === 'blob' || scheme === 'data') return true;
  // A blob: URL's origin is its creator's, so the parse below would accept a
  // `blob:https://evil.example/…` if we let it fall through — hence the
  // explicit scheme check first, and an exhaustive origin test after it.
  let parsed: URL;
  try {
    parsed = new URL(trimmed, window.location.href);
  } catch {
    return false;
  }
  if (parsed.origin === window.location.origin) return true;
  return relayOrigin !== null && parsed.origin === relayOrigin;
}

/**
 * Make an emote renderable under `name`. Returns false (and registers nothing)
 * when the URL is not one of the origins above — callers treat that as "this
 * emote does not resolve", which degrades to literal `:shortcode:` text.
 */
export function registerEmote(name: string, url: string, id?: string): boolean {
  if (!isAllowedEmoteUrl(url)) return false;
  const existing = emotes.get(name);
  emotes.set(name, { url, id: id ?? existing?.id, preview: existing?.preview });
  return true;
}

/**
 * Register a **browsing-only** URL for a picker tile.
 *
 * Search results are not content: they must render a thumbnail without being
 * usable to render a message. Keeping them in a separate field is what stops
 * the picker becoming a cap bypass — previously the picker registered
 * relay-absolute URLs into the same slot content resolution reads, so once you
 * had opened the picker (which auto-searches), any message using one of those
 * ~60 shortcodes rendered `<img src="https://relay/…">` straight from the
 * webview: no core, no per-message budget, no cache write, no offline, and one
 * relay GET per render.
 */
export function registerEmotePreview(name: string, url: string, id?: string): boolean {
  if (!isAllowedEmoteUrl(url)) return false;
  const existing = emotes.get(name);
  emotes.set(name, { url: existing?.url ?? '', id: id ?? existing?.id, preview: url });
  return true;
}

/** Remember an emote's id without making it renderable yet (the offline cached
 *  list: names + ids, bytes only on demand). */
export function registerEmoteId(name: string, id: string): void {
  const existing = emotes.get(name);
  if (existing) existing.id = id;
  else emotes.set(name, { url: '', id });
}

/** Drop every registered emote (on lock / account switch). */
export function clearEmotes(): void {
  emotes.clear();
}

/** Resolve a :shortcode: for CONTENT: only an emote whose bytes the core has
 *  cached (a `blob:`) counts. A picker preview deliberately does not. */
export function resolveEmoji(name: string): string | null {
  return emotes.get(name)?.url || null;
}

/** Resolve a :shortcode: for BROWSING (picker tiles): the cached blob if we
 *  have one, else the relay-hosted preview. Never used to render content. */
export function resolvePreviewEmoji(name: string): string | null {
  const e = emotes.get(name);
  return e?.url || e?.preview || null;
}

/** The 7TV id registered for a shortcode, if one is known. */
export function emoteIdFor(name: string): string | null {
  return emotes.get(name)?.id ?? null;
}

/** Every shortcode that currently shows an image (autocomplete's set). Includes
 *  previews: suggesting a name you just searched for is browsing, not content. */
export function registeredEmoteNames(): string[] {
  return [...emotes.entries()].filter(([, e]) => !!e.url || !!e.preview).map(([name]) => name);
}

/** Shortcode pattern used both for rendering and for picker insertion. */
export const SHORTCODE_RE = /:([A-Za-z0-9_]{2,40}):/g;

// Unicode emoji run: a pictographic base plus optional variation selector
// (️), skin-tone modifier, and ZWJ-joined (‍) continuations — so a
// multi-codepoint emoji (e.g. a family glyph) counts as one. Used only to
// detect "emote-only" messages.
const UNICODE_EMOJI_RE =
  /\p{Extended_Pictographic}(?:️|[\u{1F3FB}-\u{1F3FF}]|‍\p{Extended_Pictographic})*/gu;

/** True when `text` is made up solely of emotes — resolvable `:shortcode:`
 *  emotes and/or unicode emoji — plus whitespace, with at least one emote
 *  present. Emote-only chat messages render enlarged. */
export function isEmoteOnly(text: string | null | undefined): boolean {
  const trimmed = text?.trim();
  if (!trimmed) return false;
  let found = false;
  let rest = trimmed.replace(new RegExp(SHORTCODE_RE.source, 'g'), (m, name: string) => {
    if (resolveEmoji(name)) {
      found = true;
      return '';
    }
    return m;
  });
  rest = rest.replace(UNICODE_EMOJI_RE, () => {
    found = true;
    return '';
  });
  return found && rest.trim() === '';
}
