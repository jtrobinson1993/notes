import { afterEach, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { extendedSyntax } from '../../src/lib/editor/syntax';
import { livePreview } from '../../src/lib/editor/livePreview';

const md = () => markdown({ base: markdownLanguage, extensions: extendedSyntax });
const views: EditorView[] = [];
function makeEditor(doc: string): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [md(), livePreview()] }) });
  views.push(view);
  return view;
}
const visible = (v: EditorView) => v.dom.querySelector('.cm-content')?.textContent ?? '';

afterEach(() => {
  for (const v of views.splice(0)) {
    v.dom.parentElement?.remove();
    v.destroy();
  }
});

describe('inline mark concealment + styling', () => {
  it.each([
    ['**bold**', 'bold', '.cm-live-strong'],
    ['*em*', 'em', '.cm-live-em'],
    ['~~strike~~', 'strike', '.cm-live-strike'],
    ['==hl==', 'hl', '.cm-live-highlight'],
    ['`code`', 'code', '.cm-live-code'],
  ])('%s conceals its markers and styles the content', (src, text, sel) => {
    const v = makeEditor(src);
    expect(visible(v)).toBe(text); // markers gone
    expect(v.dom.querySelector(sel)).not.toBeNull();
  });

  it('an escaped char shows only the literal', () => {
    expect(visible(makeEditor('\\*x'))).toBe('*x');
  });
});

describe('spoilers', () => {
  it('hides the || markers and blurs content by default', () => {
    const v = makeEditor('a ||secret|| b');
    expect(visible(v)).toBe('a secret b'); // markers concealed
    const sp = v.dom.querySelector('.cm-live-spoiler')!;
    expect(sp).not.toBeNull();
    expect(sp.classList.contains('cm-spoiler-revealed')).toBe(false);
  });
});

describe('links, quotes, lists, rules', () => {
  it('a link conceals its URL and styles the text', () => {
    const v = makeEditor('[text](https://example.com)');
    expect(visible(v)).toBe('text'); // URL + parens concealed
    expect(v.dom.querySelector('.cm-live-link')).not.toBeNull();
  });

  it('a blockquote gets the quote line class and hides the marker', () => {
    const v = makeEditor('> quoted');
    expect(visible(v)).toBe('quoted');
    expect(v.dom.querySelector('.cm-live-quote')).not.toBeNull();
  });

  it('a bullet list renders a bullet widget instead of the marker', () => {
    const v = makeEditor('- item');
    expect(visible(v).trim()).toBe('item'); // the "-" marker is replaced by the bullet widget
    expect(v.dom.querySelector('.cm-live-bullet')).not.toBeNull();
  });

  it('renders a bullet immediately for "- " on a line broken off a paragraph', () => {
    // CommonMark won't let the empty item interrupt the paragraph, but the
    // live editor shows the bullet right away (matching a fresh line).
    const v = makeEditor('text\n- ');
    const bullets = v.dom.querySelectorAll('.cm-live-bullet');
    expect(bullets.length).toBe(1);
  });

  it('does not double-render a bullet for a real list item', () => {
    const v = makeEditor('- item');
    expect(v.dom.querySelectorAll('.cm-live-bullet').length).toBe(1);
  });

  it('a horizontal rule renders an hr widget', () => {
    const v = makeEditor('---');
    expect(v.dom.querySelector('.cm-live-hr')).not.toBeNull();
  });

  it('a populated ATX heading conceals its "# " prefix', () => {
    expect(visible(makeEditor('# Heading'))).toBe('Heading');
  });
});

describe('color spans', () => {
  it('applies the validated color and conceals the tags', () => {
    const v = makeEditor('<span style="color:var(--brand-red)">tinted</span>');
    expect(visible(v)).toBe('tinted'); // <span ...> and </span> concealed
    const styled = [...v.dom.querySelectorAll<HTMLElement>('.cm-content [style]')].find((e) =>
      e.getAttribute('style')?.includes('color'),
    );
    expect(styled).toBeTruthy();
  });
});
