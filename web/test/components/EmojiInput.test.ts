import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import EmojiInput from '../../src/components/EmojiInput.vue';
import { customEmoji } from '../../src/lib/emoji/custom';
import { registerCustomEmoji, clearCustomEmoji } from '../../src/lib/emoji';

beforeEach(() => {
  customEmoji.items = [{ name: 'partyblob', ref: { id: 'a', name: 'p', type: 'image/webp', size: 1, key: 'k', iv: 'i' } }];
  registerCustomEmoji('partyblob', 'blob:partyblob');
});
afterEach(() => {
  customEmoji.items = [];
  clearCustomEmoji();
});

describe('EmojiInput — : autocomplete', () => {
  it('pops a suggestion while typing :shortcode and inserts the picked emote', async () => {
    const w = mount(EmojiInput);
    const input = w.find('input');
    await input.setValue(':party');
    (input.element as HTMLInputElement).setSelectionRange(6, 6);
    await input.trigger('keyup');

    // The popup lists the matching custom emote.
    expect(w.find('ul').exists()).toBe(true);
    expect(w.text()).toContain(':partyblob:');

    // Picking it replaces the typed `:party` with the full :shortcode:.
    await w.find('ul button').trigger('mousedown');
    expect(w.emitted('update:modelValue')!.at(-1)).toEqual([':partyblob:']);
    expect(w.find('ul').exists()).toBe(false);
  });

  it('does not pop for a bare colon or under two characters', async () => {
    const w = mount(EmojiInput);
    const input = w.find('input');
    await input.setValue(':p');
    (input.element as HTMLInputElement).setSelectionRange(2, 2);
    await input.trigger('keyup');
    expect(w.find('ul').exists()).toBe(false);
  });

  it('suppresses autocomplete when readonly', async () => {
    const w = mount(EmojiInput, { props: { readonly: true } });
    const input = w.find('input');
    await input.setValue(':party');
    (input.element as HTMLInputElement).setSelectionRange(6, 6);
    await input.trigger('keyup');
    expect(w.find('ul').exists()).toBe(false);
  });
});
