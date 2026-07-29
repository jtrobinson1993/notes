import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

// The bundled custom-emote manifest is gone; the working set is unicode emoji
// (plus any emote a caller registers at runtime). Stub the emojibase dataset so
// the test doesn't pull ~1900 entries in.
const uni = vi.hoisted(() => ({
  list: [
    { unicode: '😀', label: 'grinning face', tags: ['grin'] },
    { unicode: '🎉', label: 'party popper', tags: ['party'] },
  ],
}));
vi.mock('../../src/lib/emoji/unicode', () => ({
  loadUnicodeEmoji: vi.fn(async () => uni.list),
  searchUnicode: (list: typeof uni.list, query: string, limit = 90) => {
    const q = query.trim().toLowerCase();
    return list
      .filter((e) => !q || e.label.includes(q) || e.tags.some((t) => t.includes(q)))
      .slice(0, limit);
  },
}));

// Usage tracking persists into the encrypted vault; there is no core here.
vi.mock('../../src/lib/native', () => ({
  settingsGet: vi.fn().mockResolvedValue(null),
  settingsSet: vi.fn().mockResolvedValue(undefined),
}));

import EmojiInput from '../../src/components/EmojiInput.vue';
import { clearEmotes, registerEmote } from '../../src/lib/emoji';
import { resetEmojiUsage } from '../../src/lib/emoji/usage';

beforeEach(() => resetEmojiUsage());
afterEach(() => {
  resetEmojiUsage();
  clearEmotes();
});

/** Type `text` and put the caret at its end, then fire the keyup the component
 *  listens on. The unicode set loads lazily on the first trigger, so the popup
 *  opens on the keystroke after it resolves. */
async function type(w: ReturnType<typeof mount>, text: string): Promise<void> {
  const input = w.find('input');
  await input.setValue(text);
  (input.element as HTMLInputElement).setSelectionRange(text.length, text.length);
  await input.trigger('keyup');
  await flushPromises();
  await input.trigger('keyup');
}

describe('EmojiInput — : autocomplete', () => {
  it('pops a suggestion while typing :shortcode and inserts the picked emoji', async () => {
    const w = mount(EmojiInput);
    await type(w, ':party');

    // The popup lists the matching emoji by label.
    expect(w.find('ul').exists()).toBe(true);
    expect(w.text()).toContain('party popper');

    // Picking it replaces the typed `:party` with the glyph.
    await w.find('ul button').trigger('mousedown');
    expect(w.emitted('update:modelValue')!.at(-1)).toEqual(['🎉']);
    expect(w.find('ul').exists()).toBe(false);
  });

  it('does not pop for a bare colon or under two characters', async () => {
    const w = mount(EmojiInput);
    await type(w, ':p');
    expect(w.find('ul').exists()).toBe(false);
  });

  it('offers emotes already registered this session, and never searches while typing', async () => {
    // Typing must not trigger a relay search per keystroke — that would hand
    // the relay a keylogger's worth of prefixes. Only the registered set.
    registerEmote('partyblob', 'blob:mock/party', '01F6MEP1ZG000CSNPPXHJPRW1J');
    const w = mount(EmojiInput);
    await type(w, ':party');

    expect(w.text()).toContain(':partyblob:');
    await w.find('ul button').trigger('mousedown');
    expect(w.emitted('update:modelValue')!.at(-1)).toEqual([':partyblob:']);
  });

  it('suppresses autocomplete when readonly', async () => {
    const w = mount(EmojiInput, { props: { readonly: true } });
    await type(w, ':party');
    expect(w.find('ul').exists()).toBe(false);
  });
});
