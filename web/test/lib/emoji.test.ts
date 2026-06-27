import { afterEach, describe, expect, it } from 'vitest';
import {
  clearCustomEmoji,
  defaultEmoji,
  isEmoteOnly,
  registerCustomEmoji,
  resolveEmoji,
  searchDefaultEmoji,
} from '../../src/lib/emoji';

afterEach(() => clearCustomEmoji());

describe('emoji resolver', () => {
  it('ships a few hundred default emotes in popularity order (not alphabetized)', () => {
    expect(defaultEmoji.length).toBeGreaterThan(250);
    const names = defaultEmoji.map((e) => e.name);
    const alphabetical = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).not.toEqual(alphabetical); // order is 7TV rank, not A→Z
  });

  it('resolves a known default name to its self-hosted url', () => {
    const first = defaultEmoji[0]!;
    expect(resolveEmoji(first.name)).toBe(`/emoji/7tv/${first.file}`);
  });

  it('returns null for an unknown shortcode', () => {
    expect(resolveEmoji('definitely_not_an_emote_xyz')).toBeNull();
  });

  it('lets a custom emoji shadow a default one, and clears', () => {
    const name = defaultEmoji[0]!.name;
    registerCustomEmoji(name, 'blob:custom');
    expect(resolveEmoji(name)).toBe('blob:custom');
    clearCustomEmoji();
    expect(resolveEmoji(name)).toBe(`/emoji/7tv/${defaultEmoji[0]!.file}`);
  });
});

describe('isEmoteOnly', () => {
  const known = `:${defaultEmoji[0]!.name}:`;
  // 👨‍👩‍👧 (ZWJ-joined family) and 👍🏽 (skin-tone modifier), built by code point
  // to keep the invisible joiners out of the source.
  const family = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
  const thumbTone = String.fromCodePoint(0x1f44d, 0x1f3fd);

  it('is true for emote-only messages', () => {
    expect(isEmoteOnly(known)).toBe(true);
    expect(isEmoteOnly(`  ${known}  ${known} `)).toBe(true);
    expect(isEmoteOnly('😀')).toBe(true);
    expect(isEmoteOnly('😀😀😀')).toBe(true);
    expect(isEmoteOnly(family)).toBe(true);
    expect(isEmoteOnly(thumbTone)).toBe(true);
    expect(isEmoteOnly(`${known}😀`)).toBe(true);
  });

  it('is false when any non-emote text is present', () => {
    expect(isEmoteOnly(`${known} hi`)).toBe(false);
    expect(isEmoteOnly('😀 text')).toBe(false);
    expect(isEmoteOnly('hello')).toBe(false);
    expect(isEmoteOnly(':definitely_not_an_emote_xyz:')).toBe(false);
  });

  it('is false for empty / whitespace / null', () => {
    expect(isEmoteOnly('')).toBe(false);
    expect(isEmoteOnly('   ')).toBe(false);
    expect(isEmoteOnly(null)).toBe(false);
    expect(isEmoteOnly(undefined)).toBe(false);
  });
});

describe('searchDefaultEmoji', () => {
  it('returns the top of the set (in rank order) for an empty query', () => {
    const res = searchDefaultEmoji('');
    expect(res[0]).toEqual(defaultEmoji[0]);
  });

  it('filters case-insensitively by substring', () => {
    const sample = defaultEmoji[0]!.name.slice(0, 3).toLowerCase();
    const res = searchDefaultEmoji(sample);
    expect(res.length).toBeGreaterThan(0);
    expect(res.every((e) => e.name.toLowerCase().includes(sample))).toBe(true);
  });
});
