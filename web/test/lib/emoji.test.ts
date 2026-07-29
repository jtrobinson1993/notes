import { afterEach, describe, expect, it } from 'vitest';
import {
  clearEmotes,
  emoteIdFor,
  isAllowedEmoteUrl,
  isEmoteOnly,
  registerEmote,
  registerEmoteId,
  registeredEmoteNames,
  resolveEmoji,
  setEmoteRelayOrigin,
} from '../../src/lib/emoji';

// The bundled 7TV manifest is gone — emote images come from the relay's proxying
// endpoints now, so the registry starts empty and only resolves what a caller has
// explicitly registered.

afterEach(() => {
  clearEmotes();
  setEmoteRelayOrigin(null);
});

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

describe('emote URLs are pinned to origins this app controls', () => {
  // The whole point of the relay's emote proxy is that this device never
  // resolves a third-party host: an <img> to a CDN is an IP-revealing beacon,
  // and it would be chosen by whoever authored the content or runs the relay.
  const cdn = 'https://cdn.7tv.app/emote/x/2x.webp';

  it('refuses a third-party URL outright — no relay is "close enough"', () => {
    setEmoteRelayOrigin('https://relay.test');
    expect(isAllowedEmoteUrl(cdn)).toBe(false);
    expect(registerEmote('partyblob', cdn)).toBe(false);
    expect(resolveEmoji('partyblob')).toBeNull();
  });

  it('accepts the pinned relay origin, and only while it is pinned', () => {
    const url = 'https://relay.test/api/relay/emote/sig/abc.webp';
    // Fail closed before a relay is known.
    expect(registerEmote('partyblob', url)).toBe(false);

    setEmoteRelayOrigin('https://relay.test');
    expect(registerEmote('partyblob', url)).toBe(true);
    expect(resolveEmoji('partyblob')).toBe(url);

    // A different port or scheme is a different origin.
    expect(isAllowedEmoteUrl('https://relay.test:8443/api/relay/emote/sig/abc.webp')).toBe(false);
    expect(isAllowedEmoteUrl('http://relay.test/api/relay/emote/sig/abc.webp')).toBe(false);
    expect(isAllowedEmoteUrl('https://relay.test.evil.example/x.webp')).toBe(false);
  });

  it('accepts locally-minted sources: blob:, data: and same-origin', () => {
    expect(registerEmote('a', 'blob:mock/1')).toBe(true);
    expect(registerEmote('b', 'data:image/webp;base64,AA==')).toBe(true);
    expect(registerEmote('c', '/emoji/partyblob.webp')).toBe(true);
    expect(registerEmote('d', `${window.location.origin}/emoji/x.webp`)).toBe(true);
  });

  it('is not fooled by a blob: URL carrying a foreign origin, or by junk', () => {
    // blob:https://evil.example/… parses with a foreign origin but can only
    // ever resolve to bytes this document created — allowed, and inert.
    expect(isAllowedEmoteUrl('blob:https://evil.example/1234')).toBe(true);
    expect(isAllowedEmoteUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedEmoteUrl('//cdn.7tv.app/x.webp')).toBe(false);
    expect(isAllowedEmoteUrl('')).toBe(false);
    expect(isAllowedEmoteUrl('   ')).toBe(false);
  });

  it('ignores an unparseable relay base rather than trusting it', () => {
    setEmoteRelayOrigin('not a url');
    expect(isAllowedEmoteUrl('https://relay.test/x.webp')).toBe(false);
  });
});

describe('emote ids', () => {
  it('remembers an id without making the name renderable', () => {
    registerEmoteId('partyblob', '01F6MEP1ZG000CSNPPXHJPRW1J');
    expect(emoteIdFor('partyblob')).toBe('01F6MEP1ZG000CSNPPXHJPRW1J');
    expect(resolveEmoji('partyblob')).toBeNull();
    expect(registeredEmoteNames()).not.toContain('partyblob');

    // Registering the image later keeps the id.
    registerEmote('partyblob', 'blob:mock/1');
    expect(emoteIdFor('partyblob')).toBe('01F6MEP1ZG000CSNPPXHJPRW1J');
    expect(registeredEmoteNames()).toContain('partyblob');
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
