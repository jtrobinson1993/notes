import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MarkdownView from '../../src/components/MarkdownView.vue';

function render(source: string) {
  return mount(MarkdownView, { props: { source } });
}

describe('MarkdownView — raw HTML is inert (no v-html, token→VNode)', () => {
  it('renders a <script> tag as literal text, never as an element', () => {
    const w = render('hello <script>alert("xss")</script> world');
    expect(w.find('script').exists()).toBe(false);
    expect(w.text()).toContain('alert("xss")');
  });

  it('does not create an <img> with an onerror handler', () => {
    const w = render('<img src=x onerror="alert(1)">');
    expect(w.find('img').exists()).toBe(false);
    // The dangerous markup surfaces only as visible text.
    expect(w.text()).toContain('onerror');
  });

  it('drops a javascript: link href (renders text, not an anchor)', () => {
    const w = render('[click me](javascript:alert(1))');
    const a = w.find('a');
    expect(a.exists()).toBe(false);
    expect(w.text()).toContain('click me');
  });

  it('keeps a safe https link as a real anchor', () => {
    const w = render('[ok](https://example.com)');
    const a = w.find('a');
    expect(a.exists()).toBe(true);
    expect(a.attributes('href')).toBe('https://example.com');
  });
});

describe('MarkdownView — well-formed markdown still renders', () => {
  it('renders strong / highlight / spoiler', () => {
    const w = render('**bold** ==hi== ||secret||');
    expect(w.find('strong').exists()).toBe(true);
    expect(w.find('mark').exists()).toBe(true);
    expect(w.find('.spoiler').exists()).toBe(true);
  });
});
