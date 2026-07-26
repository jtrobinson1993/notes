import { afterEach, describe, expect, it } from 'vitest';
import { clearEmotes, isEmoteOnly, registerEmote, resolveEmoji } from '../../src/lib/emoji';

// The bundled 7TV manifest is gone — emote images come from the relay's proxying
// endpoints now, so the registry starts empty and only resolves what a caller has
// explicitly registered.

afterEach(() => clearEmotes());

describe('emote registry', () => {
  it('resolves nothing until an emote is registered', () => {
    expect(resolveEmoji('partyblob')).toBeNull();
    registerEmote('partyblob', '/emoji/partyblob.webp');
    expect(resolveEmoji('partyblob')).toBe('/emoji/partyblob.webp');
  });

  it('returns null for an unknown shortcode', () => {
    expect(resolveEmoji('definitely_not_an_emote_xyz')).toBeNull();
  });

  it('re-registering a name replaces its url, and clearEmotes drops everything', () => {
    registerEmote('partyblob', '/emoji/partyblob.webp');
    registerEmote('partyblob', 'blob:custom');
    expect(resolveEmoji('partyblob')).toBe('blob:custom');
    clearEmotes();
    expect(resolveEmoji('partyblob')).toBeNull();
  });
});

describe('isEmoteOnly', () => {
  const known = ':partyblob:';
  // 👨‍👩‍👧 (ZWJ-joined family) and 👍🏽 (skin-tone modifier), built by code point
  // to keep the invisible joiners out of the source.
  const family = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
  const thumbTone = String.fromCodePoint(0x1f44d, 0x1f3fd);

  it('is true for emote-only messages', () => {
    registerEmote('partyblob', '/emoji/partyblob.webp');
    expect(isEmoteOnly(known)).toBe(true);
    expect(isEmoteOnly(`  ${known}  ${known} `)).toBe(true);
    expect(isEmoteOnly('😀')).toBe(true);
    expect(isEmoteOnly('😀😀😀')).toBe(true);
    expect(isEmoteOnly(family)).toBe(true);
    expect(isEmoteOnly(thumbTone)).toBe(true);
    expect(isEmoteOnly(`${known}😀`)).toBe(true);
  });

  it('is false when any non-emote text is present', () => {
    registerEmote('partyblob', '/emoji/partyblob.webp');
    expect(isEmoteOnly(`${known} hi`)).toBe(false);
    expect(isEmoteOnly('😀 text')).toBe(false);
    expect(isEmoteOnly('hello')).toBe(false);
    expect(isEmoteOnly(':definitely_not_an_emote_xyz:')).toBe(false);
  });

  it('is false for an unregistered shortcode (nothing to render)', () => {
    expect(isEmoteOnly(known)).toBe(false);
  });

  it('is false for empty / whitespace / null', () => {
    expect(isEmoteOnly('')).toBe(false);
    expect(isEmoteOnly('   ')).toBe(false);
    expect(isEmoteOnly(null)).toBe(false);
    expect(isEmoteOnly(undefined)).toBe(false);
  });
});
