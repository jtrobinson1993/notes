import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import MarkdownEditor from '../../src/components/MarkdownEditor.vue';

const wrappers: VueWrapper[] = [];
function makeComposer(props: Record<string, unknown> = {}) {
  const w = mount(MarkdownEditor, {
    attachTo: document.body,
    props: { modelValue: '', submitOnEnter: true, ...props },
  });
  wrappers.push(w);
  return w;
}
function pressEnter(w: VueWrapper, shift = false) {
  const content = w.element.querySelector('.cm-content') as HTMLElement;
  content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: shift, bubbles: true }));
}

afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
});

describe('MarkdownEditor composer mode', () => {
  it('emits submit on Enter without inserting a newline', () => {
    const w = makeComposer({ modelValue: 'hello' });
    pressEnter(w);
    expect(w.emitted('submit')).toHaveLength(1);
    // No newline was inserted into the document.
    expect(w.emitted('update:modelValue')).toBeUndefined();
  });

  it('Shift+Enter inserts a newline and does not submit', () => {
    const w = makeComposer({ modelValue: 'hello' });
    pressEnter(w, true);
    expect(w.emitted('submit')).toBeUndefined();
    const updates = w.emitted('update:modelValue') as string[][] | undefined;
    expect(updates?.at(-1)?.[0]).toContain('\n');
  });

  it('does not bind Enter-to-submit without submitOnEnter', () => {
    const w = makeComposer({ submitOnEnter: false, modelValue: 'hi' });
    pressEnter(w);
    expect(w.emitted('submit')).toBeUndefined();
  });
});
