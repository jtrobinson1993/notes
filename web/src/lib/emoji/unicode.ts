// Local unicode emoji search backed by emojibase-data. The dataset (~1900
// entries) is dynamically imported so it only loads when the user opens the
// unicode tab — kept out of the main bundle.

export interface UnicodeEmoji {
  unicode: string;
  label: string;
  tags: string[];
}

interface CompactEmoji {
  unicode: string;
  label: string;
  tags?: string[];
  group?: number;
}

let cache: UnicodeEmoji[] | null = null;

/** Load + normalize the unicode emoji set (cached). Excludes component glyphs
 *  (group 2: skin tones / hair) and anything without a real group. */
export async function loadUnicodeEmoji(): Promise<UnicodeEmoji[]> {
  if (cache) return cache;
  const mod = (await import('emojibase-data/en/compact.json')) as unknown as { default: CompactEmoji[] };
  cache = mod.default
    .filter((e) => e.group !== undefined && e.group !== 2 && !!e.unicode)
    .map((e) => ({ unicode: e.unicode, label: e.label, tags: e.tags ?? [] }));
  return cache;
}

/** Substring match over label + tags, preserving emojibase order. */
export function searchUnicode(list: UnicodeEmoji[], query: string, limit = 90): UnicodeEmoji[] {
  const q = query.trim().toLowerCase();
  if (!q) return list.slice(0, limit);
  const out: UnicodeEmoji[] = [];
  for (const e of list) {
    if (e.label.includes(q) || e.tags.some((t) => t.includes(q))) {
      out.push(e);
      if (out.length >= limit) break;
    }
  }
  return out;
}
