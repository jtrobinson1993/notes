import manifest from './defaultEmoji.json';

export interface DefaultEmoji {
  name: string;
  file: string;
  w: number;
  h: number;
  animated: boolean;
}

/** Default 7TV emote set, in 7TV popularity order (most-used first). The bundled
 *  manifest is metadata only (names → 7TV ids); the images are fetched from 7TV
 *  and cached by our server, served from `/emoji/7tv/` (see server/routes/emoji
 *  and scripts/fetch-emojis.mjs, which refreshes this manifest from the API). */
export const defaultEmoji = manifest as DefaultEmoji[];

export function emojiUrl(file: string): string {
  return `/emoji/7tv/${file}`;
}

const byName = new Map(defaultEmoji.map((e) => [e.name, emojiUrl(e.file)]));

// Per-user custom emoji are registered here at runtime (decrypted to object
// URLs by the custom-emoji store). Kept separate so a custom name shadows a
// default one.
const customByName = new Map<string, string>();

export function registerCustomEmoji(name: string, url: string): void {
  customByName.set(name, url);
}

export function clearCustomEmoji(): void {
  customByName.clear();
}

/** Shortcode pattern used both for rendering and for picker insertion. */
export const SHORTCODE_RE = /:([A-Za-z0-9_]{2,40}):/g;

/** Resolve a :shortcode: name to a renderable image URL, or null if unknown. */
export function resolveEmoji(name: string): string | null {
  return customByName.get(name) ?? byName.get(name) ?? null;
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

/** Filter the default set by substring (case-insensitive), preserving
 *  popularity order. */
export function searchDefaultEmoji(query: string, limit = 90): DefaultEmoji[] {
  const q = query.trim().toLowerCase();
  const list = q ? defaultEmoji.filter((e) => e.name.toLowerCase().includes(q)) : defaultEmoji;
  return list.slice(0, limit);
}
