import { describe, expect, it } from 'vitest';
import { loadUnicodeEmoji, searchUnicode, type UnicodeEmoji } from '../../src/lib/emoji/unicode';

const fixture: UnicodeEmoji[] = [
  { unicode: '😀', label: 'grinning face', tags: ['happy', 'smile'] },
  { unicode: '🐱', label: 'cat face', tags: ['animal', 'pet'] },
  { unicode: '🍕', label: 'pizza', tags: ['food', 'italian'] },
];

describe('searchUnicode', () => {
  it('returns the head of the list for an empty query', () => {
    expect(searchUnicode(fixture, '', 2)).toEqual(fixture.slice(0, 2));
  });

  it('matches the label', () => {
    expect(searchUnicode(fixture, 'pizza').map((e) => e.unicode)).toEqual(['🍕']);
  });

  it('matches a tag, case-insensitively', () => {
    expect(searchUnicode(fixture, 'PET').map((e) => e.unicode)).toEqual(['🐱']);
  });
});

describe('loadUnicodeEmoji', () => {
  it('loads + caches the emojibase set, excluding component glyphs', async () => {
    const a = await loadUnicodeEmoji();
    const b = await loadUnicodeEmoji();
    expect(a).toBe(b); // cached
    expect(a.length).toBeGreaterThan(1000);
    expect(a.some((e) => e.label === 'grinning face')).toBe(true);
    // every entry has a real character + a label
    expect(a.every((e) => e.unicode && e.label)).toBe(true);
  });
});
