import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  rankEmoji,
  recordEmojiUse,
  resetEmojiUsage,
  topUsed,
  usageKey,
  usageScore,
} from '../../src/lib/emoji/usage';
import { customEmoji } from '../../src/lib/emoji/custom';
import type { UnicodeEmoji } from '../../src/lib/emoji/unicode';

const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

const unicodeList: UnicodeEmoji[] = [
  { unicode: '🎉', label: 'party popper', tags: ['party', 'tada'] },
  { unicode: '😄', label: 'grinning face', tags: ['happy'] },
];

beforeEach(() => {
  resetEmojiUsage();
  customEmoji.items = [];
});
afterEach(() => {
  resetEmojiUsage();
  customEmoji.items = [];
});

describe('usage scoring + decay', () => {
  it('bumps a key by 1 on each use', () => {
    const now = 1_000_000;
    recordEmojiUse(usageKey.unicode('🎉'), now);
    expect(usageScore(usageKey.unicode('🎉'), now)).toBeCloseTo(1);
    recordEmojiUse(usageKey.unicode('🎉'), now);
    expect(usageScore(usageKey.unicode('🎉'), now)).toBeCloseTo(2);
  });

  it('halves a use\'s weight after one half-life', () => {
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
  it('orders custom before unicode for a shared query (no usage yet)', () => {
    customEmoji.items = [{ name: 'partyblob', ref: { id: 'a', name: 'a', type: 'image/png', size: 1, key: 'k', iv: 'v' } }];
    const res = rankEmoji('party', unicodeList, 50, 1_000);
    const custom = res.findIndex((c) => c.key === usageKey.custom('partyblob'));
    const uni = res.findIndex((c) => c.key === usageKey.unicode('🎉'));
    expect(custom).toBeGreaterThanOrEqual(0);
    expect(uni).toBeGreaterThanOrEqual(0);
    expect(custom).toBeLessThan(uni); // custom tier above unicode tier
  });

  it('floats a most-used emoji to the very top, above its source tier', () => {
    customEmoji.items = [{ name: 'partyblob', ref: { id: 'a', name: 'a', type: 'image/png', size: 1, key: 'k', iv: 'v' } }];
    const now = 1_000;
    // 🎉 (unicode) is normally below custom, but heavy recent use floats it up
    for (let i = 0; i < 5; i++) recordEmojiUse(usageKey.unicode('🎉'), now);
    const res = rankEmoji('party', unicodeList, 50, now);
    expect(res[0]!.key).toBe(usageKey.unicode('🎉'));
  });

  it('de-dupes: a most-used emoji appears once', () => {
    const now = 1_000;
    recordEmojiUse(usageKey.unicode('🎉'), now);
    const res = rankEmoji('party', unicodeList, 50, now);
    expect(res.filter((c) => c.key === usageKey.unicode('🎉')).length).toBe(1);
  });
});
