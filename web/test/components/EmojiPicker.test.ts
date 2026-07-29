import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

// The picker: search runs in the core (never fetch() from the webview), results
// are relay-origin only, browsing writes nothing to the emote cache, and an
// unreachable relay falls back to the emotes this device already holds.

const native = vi.hoisted(() => ({
  emoteSearch: vi.fn(),
  emoteGet: vi.fn(),
  emoteCachedList: vi.fn(),
  relayStatus: vi.fn(),
}));
vi.mock('../../src/lib/native', () => native);

const toast = vi.hoisted(() => ({ toastError: vi.fn(), toastInfo: vi.fn() }));
vi.mock('../../src/lib/toast', () => toast);

import EmojiPicker from '../../src/components/EmojiPicker.vue';
import { clearEmotes, resolveEmoji, resolvePreviewEmoji, setEmoteRelayOrigin } from '../../src/lib/emoji';
import { resetEmoteRender } from '../../src/lib/emoji/render';
import { resetEmojiUsage } from '../../src/lib/emoji/usage';

const ID = '01F6MEP1ZG000CSNPPXHJPRW1J';
const ID2 = '01F6MEP1ZG000CSNPPXHJPRW2K';

function hit(name: string, id = ID, host = 'https://relay.test') {
  return { id, name, url: `${host}/api/relay/emote/sig/${id}.webp`, width: 32, height: 32, animated: false };
}

/** Mount the picker with its popover already open (reka-ui portals the panel
 *  into document.body, so query from there). */
async function openPicker() {
  const w = mount(EmojiPicker, { attachTo: document.body });
  await w.find('[data-testid="emoji-picker-trigger"]').trigger('click');
  await flushPromises();
  return w;
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  resetEmoteRender();
  resetEmojiUsage();
  clearEmotes();
  setEmoteRelayOrigin('https://relay.test');
  native.emoteSearch.mockResolvedValue({ results: [hit('partyblob'), hit('pepega', ID2)], next: null });
  native.emoteCachedList.mockResolvedValue([]);
  native.emoteGet.mockResolvedValue({
    id: ID,
    name: 'partyblob',
    mime: 'image/webp',
    width: 32,
    height: 32,
    animated: false,
    bytes: [1],
    fetched: false,
  });
});

describe('EmojiPicker — search goes through the core', () => {
  it('loads the relay default set on open and renders the results', async () => {
    const w = await openPicker();

    expect(native.emoteSearch).toHaveBeenCalledWith('', 1, 60);
    // A browsed emote shows as a tile...
    expect(resolvePreviewEmoji('partyblob')).toBe(`https://relay.test/api/relay/emote/sig/${ID}.webp`);
    // ...but must NOT become content-renderable, or the picker would be a
    // bypass of the cache and the per-message fetch cap.
    expect(resolveEmoji('partyblob')).toBeNull();
    expect(document.querySelectorAll('[data-testid="emoji-result"]')).toHaveLength(2);
    w.unmount();
  });

  it('never writes to the emote cache — browsing is not usage', async () => {
    const w = await openPicker();

    expect(native.emoteGet).not.toHaveBeenCalled();
    w.unmount();
  });

  it('drops a result whose URL is not the relay origin (a hostile relay)', async () => {
    native.emoteSearch.mockResolvedValue({
      results: [hit('partyblob'), hit('leaky', ID2, 'https://cdn.7tv.app')],
      next: null,
    });
    const w = await openPicker();

    expect(resolveEmoji('leaky')).toBeNull();
    expect(document.querySelectorAll('[data-testid="emoji-result"]')).toHaveLength(1);
    w.unmount();
  });

  it('de-dupes shortcodes so one name is one tile', async () => {
    native.emoteSearch.mockResolvedValue({ results: [hit('partyblob'), hit('partyblob', ID2)], next: null });
    const w = await openPicker();

    expect(document.querySelectorAll('[data-testid="emoji-result"]')).toHaveLength(1);
    w.unmount();
  });

  it('searches the typed query (debounced) and emits the picked shortcode', async () => {
    vi.useFakeTimers();
    const w = mount(EmojiPicker, { attachTo: document.body });
    await w.find('[data-testid="emoji-picker-trigger"]').trigger('click');
    await vi.runAllTimersAsync();

    const input = document.querySelector<HTMLInputElement>('[data-testid="emoji-search"]')!;
    input.value = 'party';
    input.dispatchEvent(new Event('input'));
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    await flushPromises();

    expect(native.emoteSearch).toHaveBeenLastCalledWith('party', 1, 60);

    document.querySelector<HTMLButtonElement>('[data-testid="emoji-result"]')!.click();
    await flushPromises();
    expect(w.emitted('pick')?.[0]).toEqual([':partyblob:']);
    w.unmount();
  });
});

describe('EmojiPicker — offline', () => {
  it('falls back to the emotes this device already holds', async () => {
    native.emoteSearch.mockRejectedValue(new Error('relay unreachable'));
    native.emoteCachedList.mockResolvedValue([
      { id: ID, name: 'partyblob', width: 32, height: 32, animated: false, lastUsedAt: 2 },
    ]);
    const w = await openPicker();
    await flushPromises();

    expect(native.emoteCachedList).toHaveBeenCalled();
    // A cache read, not a fetch: the emote is already on disk.
    expect(native.emoteGet).toHaveBeenCalledWith(ID, 'partyblob');
    expect(document.querySelector('[data-testid="emoji-offline"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-testid="emoji-result"]')).toHaveLength(1);
    expect(toast.toastError).not.toHaveBeenCalled();
    w.unmount();
  });

  it('raises the catalogued error when there is nothing to fall back on', async () => {
    native.emoteSearch.mockRejectedValue(new Error('relay unreachable'));
    native.emoteCachedList.mockResolvedValue([]);
    const w = await openPicker();

    expect(toast.toastError).toHaveBeenCalledWith('EMOTE_SEARCH_UNAVAILABLE');
    expect(toast.toastError).toHaveBeenCalledTimes(1); // once per opening, not per keystroke
    w.unmount();
  });
});
