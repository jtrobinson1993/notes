import { reactive } from 'vue';
import { useSessionStore } from '../../stores/session';
import { api } from '../api';
import { unwrapKey, wrapKey } from '../crypto';
import { defaultEmoji, emojiUrl, resolveEmoji, searchDefaultEmoji } from './index';
import { customEmoji } from './custom';
import { searchUnicode, type UnicodeEmoji } from './unicode';

// "Most-used" emoji tracking. Each use bumps a per-emoji score that decays over
// time (recent favorites outrank stale all-time winners), so the autocomplete
// and picker can float frequently-used emoji to the top. The map is stored as a
// master-key-encrypted settings blob — same mechanism as the custom-emoji
// palette — so usage follows the account across devices and the server never
// sees it. Keys are source-tagged (`7tv:`/`custom:`/`uni:`) so the same name
// across sources, and the same glyph, never collide.

const SETTING_KEY = 'emoji-usage';
const INFO = 'notes:wrap:settings:v1';
// Half-life of a use's weight. After this long, a single past use counts half
// as much — so a burst of recent uses overtakes an old habit within ~2 weeks.
const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
// Cap persisted entries (the settings blob is capped at 64KB server-side); keep
// the highest-scoring ones.
const MAX_ENTRIES = 300;
const PERSIST_DEBOUNCE_MS = 1500;

export interface UsageEntry {
  score: number;
  lastUsed: number;
}

export const emojiUsage = reactive<{ map: Record<string, UsageEntry> }>({ map: {} });

export type EmojiSource = 'custom' | '7tv' | 'unicode';

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
  sevenTv: (name: string) => `7tv:${name}`,
  custom: (name: string) => `custom:${name}`,
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

function customCandidate(name: string): EmojiCandidate {
  return { source: 'custom', key: usageKey.custom(name), insert: `:${name}:`, label: `:${name}:`, url: resolveEmoji(name) ?? undefined };
}
function sevenTvCandidate(name: string, file: string): EmojiCandidate {
  return { source: '7tv', key: usageKey.sevenTv(name), insert: `:${name}:`, label: `:${name}:`, url: emojiUrl(file) };
}
function unicodeCandidate(e: UnicodeEmoji): EmojiCandidate {
  return { source: 'unicode', key: usageKey.unicode(e.unicode), insert: e.unicode, label: e.label, char: e.unicode };
}

function customMatches(query: string): EmojiCandidate[] {
  const q = query.trim().toLowerCase();
  const items = q ? customEmoji.items.filter((e) => e.name.toLowerCase().includes(q)) : customEmoji.items;
  return items.map((e) => customCandidate(e.name));
}

/** Ranked candidates for a query: a most-used tier (decayed score, any source)
 *  on top, then custom → 7TV → unicode in their natural order, de-duped by key.
 *  `unicodeList` is the lazily-loaded unicode set, or null to omit unicode. */
export function rankEmoji(
  query: string,
  unicodeList: UnicodeEmoji[] | null,
  limit = 50,
  now: number = Date.now(),
): EmojiCandidate[] {
  const tiers: EmojiCandidate[] = [
    ...customMatches(query),
    ...searchDefaultEmoji(query, limit).map((e) => sevenTvCandidate(e.name, e.file)),
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

// Convenience builders for callers that already know the picked emoji.
export function recordCustomUse(name: string): void {
  recordEmojiUse(usageKey.custom(name));
}
export function recordSevenTvUse(name: string): void {
  recordEmojiUse(usageKey.sevenTv(name));
}
export function recordUnicodeUse(glyph: string): void {
  recordEmojiUse(usageKey.unicode(glyph));
}

/** Render data for a most-used key, or null if the source emoji is gone. Used by
 *  the picker's "Frequently used" row. */
export function candidateForKey(key: string): EmojiCandidate | null {
  if (key.startsWith('custom:')) {
    const name = key.slice('custom:'.length);
    return customEmoji.items.some((e) => e.name === name) ? customCandidate(name) : null;
  }
  if (key.startsWith('7tv:')) {
    const name = key.slice('7tv:'.length);
    const e = defaultEmoji.find((x) => x.name === name);
    return e ? sevenTvCandidate(e.name, e.file) : null;
  }
  if (key.startsWith('uni:')) {
    const glyph = key.slice('uni:'.length);
    return { source: 'unicode', key, insert: glyph, label: glyph, char: glyph };
  }
  return null;
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
  let mk: Uint8Array | null | undefined;
  try {
    mk = useSessionStore().mk;
  } catch {
    return; // no active store (e.g. tests) — nothing to sync
  }
  if (!mk) return;
  prune();
  const wrapped = await wrapKey(mk, new TextEncoder().encode(JSON.stringify(emojiUsage.map)), INFO);
  await api.settingPut(SETTING_KEY, JSON.stringify(wrapped)).catch(() => {});
}

let loaded = false;

/** Fetch + decrypt the usage map. Safe to call repeatedly. */
export async function loadEmojiUsage(): Promise<void> {
  const session = useSessionStore();
  if (loaded || !session.mk) return;
  loaded = true;
  try {
    const remote = await api.settingGet(SETTING_KEY);
    if (!remote) return;
    const pt = await unwrapKey(session.mk, JSON.parse(remote.data), INFO);
    emojiUsage.map = JSON.parse(new TextDecoder().decode(pt)) as Record<string, UsageEntry>;
  } catch {
    loaded = false; // network/decrypt hiccup: retry next call
  }
}

/** Clear in-memory usage (on lock/logout). */
export function resetEmojiUsage(): void {
  loaded = false;
  emojiUsage.map = {};
  clearTimeout(persistTimer);
}
