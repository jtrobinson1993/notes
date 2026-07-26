import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  rankEmoji,
  recordEmojiUse,
  resetEmojiUsage,
  topUsed,
  usageKey,
  usageScore,
} from '../../src/lib/emoji/usage';
import { clearEmotes, registerEmote } from '../../src/lib/emoji';
import type { UnicodeEmoji } from '../../src/lib/emoji/unicode';

// The usage map persists into the encrypted vault via the Rust core; there is no
// core under vitest, so stub the settings IPC out.
vi.mock('../../src/lib/native', () => ({
  settingsGet: vi.fn(async () => null),
  settingsSet: vi.fn(async () => undefined),
}));

const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

const unicodeList: UnicodeEmoji[] = [
  { unicode: '🎉', label: 'party popper', tags: ['party', 'tada'] },
  { unicode: '😄', label: 'grinning face', tags: ['happy'] },
];

beforeEach(() => {
  resetEmojiUsage();
  clearEmotes();
});
afterEach(() => {
  resetEmojiUsage();
  clearEmotes();
});

describe('usage scoring + decay', () => {
  it('bumps a key by 1 on each use', () => {
    const now = 1_000_000;
    recordEmojiUse(usageKey.unicode('🎉'), now);
    expect(usageScore(usageKey.unicode('🎉'), now)).toBeCloseTo(1);
    recordEmojiUse(usageKey.unicode('🎉'), now);
    expect(usageScore(usageKey.unicode('🎉'), now)).toBeCloseTo(2);
  });

  it("halves a use's weight after one half-life", () => {
    const t0 = 1_000_000;
    recordEmojiUse(usageKey.unicode('🎉'), t0);
    expect(usageScore(usageKey.unicode('🎉'), t0 + HALF_LIFE_MS)).toBeCloseTo(0.5);
  });

  it('lets recent uses overtake an old habit', () => {
    const t0 = 0;
    const old = usageKey.unicode('😄');
    const fresh = usageKey.unicode('🎉');
    // 😄 used 4× long ago, 🎉 used 2× recently
    for (let i = 0; i < 4; i++) recordEmojiUse(old, t0);
    const later = t0 + 3 * HALF_LIFE_MS; // 😄 decays to 4 * (1/8) = 0.5
    recordEmojiUse(fresh, later);
    recordEmojiUse(fresh, later); // 🎉 = 2
    expect(usageScore(fresh, later)).toBeGreaterThan(usageScore(old, later));
  });

  it('keys are source-tagged so an emote and a glyph never collide', () => {
    expect(usageKey.emote('party')).not.toBe(usageKey.unicode('party'));
  });

  it('topUsed lists positive-score keys highest first', () => {
    const now = 1_000;
    recordEmojiUse(usageKey.unicode('🎉'), now);
    recordEmojiUse(usageKey.unicode('🎉'), now);
    recordEmojiUse(usageKey.unicode('😄'), now);
    const top = topUsed(now);
    expect(top[0]!.key).toBe(usageKey.unicode('🎉'));
    expect(top[1]!.key).toBe(usageKey.unicode('😄'));
  });
});

describe('rankEmoji tiering', () => {
  it('orders emotes before unicode for a shared query (no usage yet)', () => {
    registerEmote('partyblob', '/emoji/partyblob.webp');
    const res = rankEmoji('party', unicodeList, 50, 1_000, ['partyblob']);
    const emote = res.findIndex((c) => c.key === usageKey.emote('partyblob'));
    const uni = res.findIndex((c) => c.key === usageKey.unicode('🎉'));
    expect(emote).toBeGreaterThanOrEqual(0);
    expect(uni).toBeGreaterThanOrEqual(0);
    expect(emote).toBeLessThan(uni); // emote tier above unicode tier
  });

  it('carries the registered url on an emote candidate', () => {
    registerEmote('partyblob', '/emoji/partyblob.webp');
    const res = rankEmoji('party', unicodeList, 50, 1_000, ['partyblob']);
    const emote = res.find((c) => c.key === usageKey.emote('partyblob'));
    expect(emote).toMatchObject({
      source: 'emote',
      insert: ':partyblob:',
      url: '/emoji/partyblob.webp',
    });
  });

  it('floats a most-used emoji to the very top, above its source tier', () => {
    registerEmote('partyblob', '/emoji/partyblob.webp');
    const now = 1_000;
    // 🎉 (unicode) is normally below emotes, but heavy recent use floats it up
    for (let i = 0; i < 5; i++) recordEmojiUse(usageKey.unicode('🎉'), now);
    const res = rankEmoji('party', unicodeList, 50, now, ['partyblob']);
    expect(res[0]!.key).toBe(usageKey.unicode('🎉'));
  });

  it('de-dupes: a most-used emoji appears once', () => {
    const now = 1_000;
    recordEmojiUse(usageKey.unicode('🎉'), now);
    const res = rankEmoji('party', unicodeList, 50, now);
    expect(res.filter((c) => c.key === usageKey.unicode('🎉')).length).toBe(1);
  });

  it('omits unicode entirely when the set has not loaded yet', () => {
    registerEmote('partyblob', '/emoji/partyblob.webp');
    const res = rankEmoji('party', null, 50, 1_000, ['partyblob']);
    expect(res.map((c) => c.key)).toEqual([usageKey.emote('partyblob')]);
  });
});
