// Named image emotes (":shortcode:" → image URL).
//
// The bundled 7TV manifest is gone: emote images now come from the relay's
// proxying emote endpoints (it fetches + caches them, so no client ever talks to
// a third-party CDN and leaks its IP). Nothing populates this registry yet — the
// relay-backed emote search/fetch is wired up by the emoji rework — so today
// `resolveEmoji` only resolves emotes a caller has explicitly registered, and
// unicode emoji (which need no images at all) are the working set.

const emoteUrls = new Map<string, string>();

/** Make an emote renderable under `name`. `url` must be same-origin, a blob:/
 *  data: URL, or a relay URL — never a third-party CDN (IP leak). */
export function registerEmote(name: string, url: string): void {
  emoteUrls.set(name, url);
}

/** Drop every registered emote (on lock / account switch). */
export function clearEmotes(): void {
  emoteUrls.clear();
}

/** Shortcode pattern used both for rendering and for picker insertion. */
export const SHORTCODE_RE = /:([A-Za-z0-9_]{2,40}):/g;

/** Resolve a :shortcode: name to a renderable image URL, or null if unknown. */
export function resolveEmoji(name: string): string | null {
  return emoteUrls.get(name) ?? null;
}

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
