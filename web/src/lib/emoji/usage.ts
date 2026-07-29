import { reactive } from 'vue';
import { settingsGet, settingsSet } from '../native';
import { resolveEmoji } from './index';
import { searchUnicode, type UnicodeEmoji } from './unicode';

// "Most-used" emoji tracking. Each use bumps a per-emoji score that decays over
// time (recent favorites outrank stale all-time winners), so the autocomplete
// can float frequently-used emoji to the top. The map lives in the encrypted
// vault (SQLCipher `settings`, via the Rust core) — which emoji you use is
// behavioural metadata, so it never leaves the device in the clear. Keys are
// source-tagged (`emote:`/`uni:`) so a shortcode and a glyph never collide.

const SETTING_KEY = 'emoji-usage';
// Half-life of a use's weight. After this long, a single past use counts half
// as much — so a burst of recent uses overtakes an old habit within ~2 weeks.
const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
// Cap persisted entries so the blob stays small; keep the highest-scoring ones.
const MAX_ENTRIES = 300;
const PERSIST_DEBOUNCE_MS = 1500;

export interface UsageEntry {
  score: number;
  lastUsed: number;
}

export const emojiUsage = reactive<{ map: Record<string, UsageEntry> }>({ map: {} });

export type EmojiSource = 'emote' | 'unicode';

/** A renderable emoji candidate from any source, carrying its usage key and the
 *  exact text to insert (a `:shortcode:` for emotes, the glyph for unicode). */
export interface EmojiCandidate {
  source: EmojiSource;
  key: string;
  insert: string;
  label: string;
  url?: string;
  char?: string;
}

export const usageKey = {
  emote: (name: string) => `emote:${name}`,
  unicode: (glyph: string) => `uni:${glyph}`,
};

function decayed(entry: UsageEntry, now: number): number {
  const dt = now - entry.lastUsed;
  return dt <= 0 ? entry.score : entry.score * Math.pow(0.5, dt / HALF_LIFE_MS);
}

/** Current decayed score for a key (0 if never used). */
export function usageScore(key: string, now: number = Date.now()): number {
  const e = emojiUsage.map[key];
  return e ? decayed(e, now) : 0;
}

/** Record one use of an emoji, decaying its prior score before the +1 bump. */
export function recordEmojiUse(key: string, now: number = Date.now()): void {
  emojiUsage.map[key] = { score: usageScore(key, now) + 1, lastUsed: now };
  schedulePersist();
}

/** Keys with a positive decayed score, highest first. */
export function topUsed(now: number = Date.now()): { key: string; score: number }[] {
  return Object.keys(emojiUsage.map)
    .map((key) => ({ key, score: usageScore(key, now) }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score);
}

// ---- ranking --------------------------------------------------------------

function emoteCandidate(name: string): EmojiCandidate {
  return {
    source: 'emote',
    key: usageKey.emote(name),
    insert: `:${name}:`,
    label: `:${name}:`,
    url: resolveEmoji(name) ?? undefined,
  };
}
function unicodeCandidate(e: UnicodeEmoji): EmojiCandidate {
  return { source: 'unicode', key: usageKey.unicode(e.unicode), insert: e.unicode, label: e.label, char: e.unicode };
}

/** Ranked candidates for a query: a most-used tier (decayed score, any source)
 *  on top, then registered emotes → unicode in their natural order, de-duped by
 *  key. `unicodeList` is the lazily-loaded unicode set, or null to omit unicode.
 *  `emoteNames` are the currently-registered emote shortcodes to match against. */
export function rankEmoji(
  query: string,
  unicodeList: UnicodeEmoji[] | null,
  limit = 50,
  now: number = Date.now(),
  emoteNames: string[] = [],
): EmojiCandidate[] {
  const q = query.trim().toLowerCase();
  const tiers: EmojiCandidate[] = [
    ...(q ? emoteNames.filter((n) => n.toLowerCase().includes(q)) : emoteNames)
      .slice(0, limit)
      .map(emoteCandidate),
    ...(unicodeList ? searchUnicode(unicodeList, query, limit).map(unicodeCandidate) : []),
  ];

  const byKey = new Map<string, EmojiCandidate>();
  for (const c of tiers) if (!byKey.has(c.key)) byKey.set(c.key, c);
  const unique = [...byKey.values()];

  const scored = unique
    .map((c) => ({ c, score: usageScore(c.key, now) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const usedKeys = new Set(scored.map((x) => x.c.key));

  return [...scored.map((x) => x.c), ...unique.filter((c) => !usedKeys.has(c.key))].slice(0, limit);
}

/** Rebuild the candidate a usage key stands for, or null when it no longer
 *  resolves (an emote whose registration is gone — e.g. a relay you are not
 *  connected to any more). Used for the picker's "frequently used" tier. */
export function candidateForKey(key: string): EmojiCandidate | null {
  if (key.startsWith('emote:')) {
    const name = key.slice('emote:'.length);
    return resolveEmoji(name) ? emoteCandidate(name) : null;
  }
  if (key.startsWith('uni:')) {
    const glyph = key.slice('uni:'.length);
    return { source: 'unicode', key, insert: glyph, label: glyph, char: glyph };
  }
  return null;
}

// Convenience builders for callers that already know the picked emoji.
export function recordEmoteUse(name: string): void {
  recordEmojiUse(usageKey.emote(name));
}
export function recordUnicodeUse(glyph: string): void {
  recordEmojiUse(usageKey.unicode(glyph));
}

// ---- persistence (mirrors custom.ts) --------------------------------------

let persistTimer: ReturnType<typeof setTimeout> | undefined;

function schedulePersist(): void {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => void persist(), PERSIST_DEBOUNCE_MS);
}

function prune(): void {
  const top = topUsed();
  if (top.length <= MAX_ENTRIES) return;
  const keep = new Set(top.slice(0, MAX_ENTRIES).map((e) => e.key));
  emojiUsage.map = Object.fromEntries(Object.entries(emojiUsage.map).filter(([k]) => keep.has(k)));
}

async function persist(): Promise<void> {
  prune();
  // Best-effort: a locked vault (or no vault at all, e.g. the editor harness)
  // just means the tally stays in memory for this session.
  await settingsSet(SETTING_KEY, JSON.stringify(emojiUsage.map)).catch(() => {});
}

let loaded = false;

/** Read the usage map out of the encrypted vault. Safe to call repeatedly. */
export async function loadEmojiUsage(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await settingsGet(SETTING_KEY);
    if (raw) emojiUsage.map = JSON.parse(raw) as Record<string, UsageEntry>;
  } catch {
    loaded = false; // transient: retry next call
  }
}

/** Clear in-memory usage (on lock/logout). */
export function resetEmojiUsage(): void {
  loaded = false;
  emojiUsage.map = {};
  clearTimeout(persistTimer);
}
