import { beforeEach, describe, expect, it, vi } from 'vitest';

// The content-emoji policy: resolution, the on-device cache write, and the
// per-message fetch cap that stops a hostile sender turning every recipient
// into a fetch amplifier against the relay.

const native = vi.hoisted(() => ({
  emoteSearch: vi.fn(),
  emoteGet: vi.fn(),
  emoteCachedList: vi.fn(),
  relayStatus: vi.fn(),
}));
vi.mock('../../src/lib/native', () => native);

import {
  clearEmotes,
  registerEmoteId,
  registerEmotePreview,
  resolveEmoji,
  resolvePreviewEmoji,
  setEmoteRelayOrigin,
} from '../../src/lib/emoji';
import {
  cachedEmoteUrl,
  contentEmoteUrl,
  emoteBudgetSpent,
  PER_MESSAGE_EMOTE_CAP,
  resetEmoteRender,
  shortcodeNames,
} from '../../src/lib/emoji/render';

const ID = '01F6MEP1ZG000CSNPPXHJPRW1J';

function searchHit(name: string, id = ID) {
  return { id, name, url: `https://relay.test/api/relay/emote/sig/${id}.webp`, width: 32, height: 32, animated: false };
}

function image(name: string, id = ID, fetched = true) {
  return { id, name, mime: 'image/webp', width: 32, height: 32, animated: false, bytes: [1, 2, 3], fetched };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetEmoteRender();
  clearEmotes();
  setEmoteRelayOrigin('https://relay.test');
  native.emoteSearch.mockImplementation((q: string) => Promise.resolve({ results: [searchHit(q)], next: null }));
  native.emoteGet.mockImplementation((id: string, name: string) => Promise.resolve(image(name, id)));
});

describe('shortcodeNames', () => {
  it('lists each distinct shortcode once, in first-seen order', () => {
    expect(shortcodeNames('a :one: b :two: c :one:')).toEqual(['one', 'two']);
    expect(shortcodeNames('no codes here')).toEqual([]);
  });
});

describe('content emoji resolution', () => {
  it('resolves a shortcode through the core and registers it renderable', async () => {
    const url = await contentEmoteUrl('partyblob', 'msg-1');

    expect(native.emoteSearch).toHaveBeenCalledWith('partyblob', 1, 20);
    // emote_get is the cache-writing path: rendering content persists it.
    expect(native.emoteGet).toHaveBeenCalledWith(ID, 'partyblob');
    expect(url).toMatch(/^blob:/);
    expect(resolveEmoji('partyblob')).toBe(url);
  });

  it('skips the name lookup when the id is already known (the offline path)', async () => {
    registerEmoteId('partyblob', ID);
    const url = await contentEmoteUrl('partyblob', 'msg-1');

    expect(native.emoteSearch).not.toHaveBeenCalled();
    expect(native.emoteGet).toHaveBeenCalledWith(ID, 'partyblob');
    expect(url).toMatch(/^blob:/);
  });

  it('accepts only an exact name match, so the relay cannot swap the image', async () => {
    native.emoteSearch.mockResolvedValue({ results: [searchHit('something_else')], next: null });

    expect(await contentEmoteUrl('partyblob', 'msg-1')).toBeNull();
    expect(native.emoteGet).not.toHaveBeenCalled();
  });

  it('renders nothing (not a toast, not a throw) when resolution fails', async () => {
    native.emoteGet.mockRejectedValue(new Error('relay down'));
    expect(await contentEmoteUrl('partyblob', 'msg-1')).toBeNull();
  });

  it('resolves a name once even when several scopes ask concurrently', async () => {
    const [a, b] = await Promise.all([
      contentEmoteUrl('partyblob', 'msg-1'),
      contentEmoteUrl('partyblob', 'msg-2'),
    ]);
    expect(a).toBe(b);
    expect(native.emoteGet).toHaveBeenCalledTimes(1);
  });
});

describe('the per-message fetch cap', () => {
  const names = Array.from({ length: PER_MESSAGE_EMOTE_CAP + 5 }, (_, i) => `emote_${i}`);

  it('fetches at most PER_MESSAGE_EMOTE_CAP distinct emotes for one message', async () => {
    const urls = [];
    for (const n of names) urls.push(await contentEmoteUrl(n, 'msg-1'));

    expect(native.emoteGet).toHaveBeenCalledTimes(PER_MESSAGE_EMOTE_CAP);
    expect(urls.filter((u) => u !== null)).toHaveLength(PER_MESSAGE_EMOTE_CAP);
    // The rest resolve to null → the component renders literal :shortcode:.
    expect(urls.slice(PER_MESSAGE_EMOTE_CAP).every((u) => u === null)).toBe(true);
  });

  it('holds when the message is rendered again (the cap is per message, not per view)', async () => {
    for (const n of names) await contentEmoteUrl(n, 'msg-1');
    native.emoteGet.mockClear();
    native.emoteSearch.mockClear();

    // Scroll away, scroll back: every shortcode is asked for a second time.
    const second = [];
    for (const n of names) second.push(await contentEmoteUrl(n, 'msg-1'));

    // Already-resolved emotes come from the registry; the over-cap ones stay
    // literal text. Neither issues a single new relay call.
    expect(native.emoteGet).not.toHaveBeenCalled();
    expect(native.emoteSearch).not.toHaveBeenCalled();
    expect(second.filter((u) => u !== null)).toHaveLength(PER_MESSAGE_EMOTE_CAP);
  });

  it('budgets each message separately', async () => {
    for (const n of names) await contentEmoteUrl(n, 'msg-1');
    expect(emoteBudgetSpent('msg-1')).toBe(PER_MESSAGE_EMOTE_CAP);
    expect(emoteBudgetSpent('msg-2')).toBe(0);

    // A different message may still resolve a fresh emote.
    expect(await contentEmoteUrl('brand_new', 'msg-2')).toMatch(/^blob:/);
  });

  it('does not charge the budget for a cache hit, so cached emotes are unlimited', async () => {
    native.emoteGet.mockImplementation((id: string, name: string) =>
      Promise.resolve(image(name, id, /* fetched */ false)),
    );
    for (const n of names) registerEmoteId(n, ID);

    const urls = [];
    for (const n of names) urls.push(await contentEmoteUrl(n, 'msg-1'));

    expect(emoteBudgetSpent('msg-1')).toBe(0);
    expect(urls.every((u) => typeof u === 'string')).toBe(true);
  });

  it('charges a failed fetch, so re-rendering cannot retry past the cap', async () => {
    native.emoteGet.mockRejectedValue(new Error('relay down'));

    // Two full renders of a 30-emote message.
    for (let round = 0; round < 2; round++) for (const n of names) await contentEmoteUrl(n, 'msg-1');

    expect(native.emoteGet.mock.calls.length).toBeLessThanOrEqual(PER_MESSAGE_EMOTE_CAP);
    expect(emoteBudgetSpent('msg-1')).toBe(PER_MESSAGE_EMOTE_CAP);
  });

  // Regression: `networked` used to be assigned only AFTER each await, so a
  // rejected search returned networked:false, the caller refunded the slot and
  // un-admitted the name, and the cap reset completely. A 500-shortcode message
  // could then issue 500 searches per render pass, unbounded across passes —
  // amplifying hardest precisely when the relay was already failing.
  it('charges a failed SEARCH too — a rejecting relay must not reset the cap', async () => {
    native.emoteSearch.mockRejectedValue(new Error('relay 429'));

    for (let round = 0; round < 3; round++) for (const n of names) await contentEmoteUrl(n, 'msg-1');

    expect(native.emoteSearch.mock.calls.length).toBeLessThanOrEqual(PER_MESSAGE_EMOTE_CAP);
    expect(emoteBudgetSpent('msg-1')).toBe(PER_MESSAGE_EMOTE_CAP);
  });

  it('charges a search that succeeds but matches nothing', async () => {
    native.emoteSearch.mockResolvedValue({ results: [], next: null });

    for (let round = 0; round < 2; round++) for (const n of names) await contentEmoteUrl(n, 'msg-1');

    expect(native.emoteSearch.mock.calls.length).toBeLessThanOrEqual(PER_MESSAGE_EMOTE_CAP);
    expect(emoteBudgetSpent('msg-1')).toBe(PER_MESSAGE_EMOTE_CAP);
  });

  it('keeps each message on its own budget', async () => {
    native.emoteSearch.mockRejectedValue(new Error('relay down'));

    for (const n of names) await contentEmoteUrl(n, 'msg-1');
    for (const n of names) await contentEmoteUrl(n, 'msg-2');

    // A second message gets its own cap — but no message exceeds it, so total
    // work stays proportional to messages actually rendered, not to content.
    expect(emoteBudgetSpent('msg-1')).toBe(PER_MESSAGE_EMOTE_CAP);
    expect(emoteBudgetSpent('msg-2')).toBe(PER_MESSAGE_EMOTE_CAP);
    expect(native.emoteSearch.mock.calls.length).toBe(PER_MESSAGE_EMOTE_CAP * 2);
  });
});

describe('browsing must not become a content path', () => {
  // Regression: the picker used to register relay-absolute search-result URLs
  // into the same slot content resolution reads. Opening the picker (which
  // auto-searches) therefore made ~60 shortcodes render in messages straight
  // from the webview — no core, no budget, no cache write, no offline.
  it('a searched emote does not become content-renderable', async () => {
    const hit = searchHit('partyblob');
    expect(registerEmotePreview(hit.name, hit.url, hit.id)).toBe(true);

    // The picker can show it...
    expect(resolvePreviewEmoji('partyblob')).toBe(hit.url);
    // ...but content cannot, so rendering it in a message still goes to the core.
    expect(resolveEmoji('partyblob')).toBeNull();

    const url = await contentEmoteUrl('partyblob', 'msg-1');
    expect(native.emoteGet).toHaveBeenCalledWith(ID, 'partyblob');
    expect(url).toMatch(/^blob:/);
    // And the message was charged for it.
    expect(emoteBudgetSpent('msg-1')).toBe(1);
  });

  it('a preview never satisfies a capped message', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `e${i}`);
    for (const n of many) registerEmotePreview(n, searchHit(n).url, ID);
    native.emoteGet.mockRejectedValue(new Error('relay down'));

    for (const n of many) await contentEmoteUrl(n, 'msg-1');

    // Previews existing for all 30 must not let the message render past its cap.
    expect(emoteBudgetSpent('msg-1')).toBe(PER_MESSAGE_EMOTE_CAP);
    for (const n of many) expect(resolveEmoji(n)).toBeNull();
  });
});

describe('the offline picker path', () => {
  it('renders an emote the core already holds without charging any message', async () => {
    native.emoteGet.mockResolvedValue(image('partyblob', ID, false));

    const url = await cachedEmoteUrl(ID, 'partyblob');

    expect(url).toMatch(/^blob:/);
    expect(native.emoteSearch).not.toHaveBeenCalled();
    expect(emoteBudgetSpent('partyblob')).toBe(0);
  });
});

describe('resetEmoteRender', () => {
  it('revokes the decrypted blob URLs and clears every budget', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const url = await contentEmoteUrl('partyblob', 'msg-1');

    resetEmoteRender();

    expect(revoke).toHaveBeenCalledWith(url);
    expect(emoteBudgetSpent('msg-1')).toBe(0);
  });
});
