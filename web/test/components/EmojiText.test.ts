import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

// EmojiText is the one component allowed to turn a rendered `:shortcode:` into
// a cached emote, so these cases are the client half of the emoji security
// model: content caches, browsing does not, and one message can only pull a
// bounded number of images no matter how often it is re-rendered.

const native = vi.hoisted(() => ({
  emoteSearch: vi.fn(),
  emoteGet: vi.fn(),
  emoteCachedList: vi.fn(),
  relayStatus: vi.fn(),
}));
vi.mock('../../src/lib/native', () => native);

import EmojiText from '../../src/components/EmojiText.vue';
import { clearEmotes, registerEmote, setEmoteRelayOrigin } from '../../src/lib/emoji';
import { PER_MESSAGE_EMOTE_CAP, resetEmoteRender } from '../../src/lib/emoji/render';

const ID = '01F6MEP1ZG000CSNPPXHJPRW1J';

beforeEach(() => {
  vi.clearAllMocks();
  resetEmoteRender();
  clearEmotes();
  setEmoteRelayOrigin('https://relay.test');
  native.emoteSearch.mockImplementation((q: string) =>
    Promise.resolve({
      results: [{ id: ID, name: q, url: `https://relay.test/api/relay/emote/sig/${ID}.webp`, width: 32, height: 32, animated: false }],
      next: null,
    }),
  );
  native.emoteGet.mockImplementation((id: string, name: string) =>
    Promise.resolve({ id, name, mime: 'image/webp', width: 32, height: 32, animated: false, bytes: [1], fetched: true }),
  );
});

function render(text: string, scope: string | false) {
  return mount(EmojiText, { props: { text, scope } });
}

describe('EmojiText — content rendering caches what it displays', () => {
  it('resolves a shortcode through the core and shows the image', async () => {
    const w = render('hi :partyblob: there', 'msg-1');
    await flushPromises();

    expect(native.emoteGet).toHaveBeenCalledWith(ID, 'partyblob');
    const img = w.find('img.chat-emoji');
    expect(img.exists()).toBe(true);
    expect(img.attributes('src')).toMatch(/^blob:/);
    expect(img.attributes('alt')).toBe(':partyblob:');
    expect(w.text()).toContain('hi');
    expect(w.text()).toContain('there');
  });

  it('leaves an unresolvable shortcode as literal text', async () => {
    native.emoteSearch.mockResolvedValue({ results: [], next: null });
    const w = render('a :nope_nope: b', 'msg-1');
    await flushPromises();

    expect(w.find('img').exists()).toBe(false);
    expect(w.text()).toContain(':nope_nope:');
  });

  it('renders an already-registered emote with no relay call at all', async () => {
    registerEmote('partyblob', 'https://relay.test/api/relay/emote/sig/x.webp', ID);
    const w = render(':partyblob:', 'msg-1');
    await flushPromises();

    expect(native.emoteSearch).not.toHaveBeenCalled();
    expect(native.emoteGet).not.toHaveBeenCalled();
    expect(w.find('img').exists()).toBe(true);
  });
});

describe('EmojiText — browsing (scope=false) never writes to the cache', () => {
  it('fetches nothing: the picker and search results opt out explicitly', async () => {
    const w = render(':partyblob:', false);
    await flushPromises();

    expect(native.emoteSearch).not.toHaveBeenCalled();
    expect(native.emoteGet).not.toHaveBeenCalled();
    expect(w.text()).toContain(':partyblob:'); // literal, nothing registered
  });

  it('still renders emotes already in the registry (the picker tile path)', async () => {
    registerEmote('partyblob', 'https://relay.test/api/relay/emote/sig/x.webp', ID);
    const w = mount(EmojiText, { props: { text: ':partyblob:', scope: false, size: 'tile' } });
    await flushPromises();

    expect(w.find('img.emote-tile').exists()).toBe(true);
    expect(native.emoteGet).not.toHaveBeenCalled();
  });
});

describe('EmojiText — the per-message cap', () => {
  const many = Array.from({ length: PER_MESSAGE_EMOTE_CAP + 5 }, (_, i) => `:emote_${i}:`).join(' ');

  it('caps distinct fetches per message and renders the rest as literal text', async () => {
    const w = render(many, 'msg-1');
    await flushPromises();
    await flushPromises();

    expect(native.emoteGet).toHaveBeenCalledTimes(PER_MESSAGE_EMOTE_CAP);
    expect(w.findAll('img')).toHaveLength(PER_MESSAGE_EMOTE_CAP);
    // Nothing is dropped — the over-cap emotes are still readable.
    expect(w.text()).toContain(`:emote_${PER_MESSAGE_EMOTE_CAP}:`);
    expect(w.text()).toContain(`:emote_${PER_MESSAGE_EMOTE_CAP + 4}:`);
  });

  it('survives unmount/remount — scrolling away and back buys no new budget', async () => {
    const first = render(many, 'msg-1');
    await flushPromises();
    await flushPromises();
    first.unmount();
    native.emoteGet.mockClear();
    native.emoteSearch.mockClear();

    const second = render(many, 'msg-1');
    await flushPromises();
    await flushPromises();

    expect(native.emoteGet).not.toHaveBeenCalled();
    expect(native.emoteSearch).not.toHaveBeenCalled();
    expect(second.findAll('img')).toHaveLength(PER_MESSAGE_EMOTE_CAP);
    expect(second.text()).toContain(`:emote_${PER_MESSAGE_EMOTE_CAP + 1}:`);
  });
});
