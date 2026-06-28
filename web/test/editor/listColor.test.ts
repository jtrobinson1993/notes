import { afterEach, describe, expect, it } from 'vitest';
import { EditorSelection, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { extendedSyntax } from '../../src/lib/editor/syntax';
import { livePreview } from '../../src/lib/editor/livePreview';
import { applyColor, inListItem, hopPastTrailingCloseTags } from '../../src/lib/editor/commands';

const md = () => markdown({ base: markdownLanguage, extensions: extendedSyntax });
// Mirror MarkdownEditor's close-tag hop (highest precedence, hops past trailing
// close-tags in a list then defers to markdown's own Prec.high list-continue).
const closeTagHop = Prec.highest(
  keymap.of([{ key: 'Enter', run: (v) => (inListItem(v.state) ? (hopPastTrailingCloseTags(v), false) : false) }]),
);
const views: EditorView[] = [];
function mk(doc: string, anchor: number, head: number) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(anchor, head),
      extensions: [closeTagHop, keymap.of(defaultKeymap), md(), livePreview()],
    }),
  });
  views.push(view);
  return view;
}
// Count raw <span>/</span> in the rendered (concealed) text — should be 0 when
// every color span is intact (its tags concealed).
const literalSpanTags = (v: EditorView) =>
  (v.dom.querySelector('.cm-content')?.textContent ?? '').match(/<\/?span/g)?.length ?? 0;
afterEach(() => {
  for (const v of views.splice(0)) { v.dom.parentElement?.remove(); v.destroy(); }
});

describe('color across list items wraps each item separately', () => {
  it('a single item wraps just its content', () => {
    const v = mk('- one\n- two\n- three', 8, 11); // "two"
    applyColor(v, 'var(--brand-green)');
    expect(v.state.doc.toString()).toBe('- one\n- <span style="color:var(--brand-green)">two</span>\n- three');
    expect(literalSpanTags(v)).toBe(0);
  });

  it('a selection spanning two items wraps each (no cross-boundary span)', () => {
    const v = mk('- one\n- two\n- three', 8, 17); // "two\n- thr"
    applyColor(v, 'var(--brand-green)');
    expect(v.state.doc.toString()).toBe(
      '- one\n- <span style="color:var(--brand-green)">two</span>\n- <span style="color:var(--brand-green)">thr</span>ee',
    );
    expect(literalSpanTags(v)).toBe(0);
  });

  it('selecting all three items colors each one', () => {
    const v = mk('- one\n- two\n- three', 2, 19);
    applyColor(v, 'var(--brand-green)');
    expect(v.state.doc.toString()).toBe(
      '- <span style="color:var(--brand-green)">one</span>\n' +
        '- <span style="color:var(--brand-green)">two</span>\n' +
        '- <span style="color:var(--brand-green)">three</span>',
    );
    expect(literalSpanTags(v)).toBe(0);
  });
});

describe('Enter in a colored list item keeps the close tag on the item', () => {
  it('continues the list without splitting </span> onto the new bullet', () => {
    const doc = '- <span style="color:var(--brand-green)">two</span>';
    const v = mk(doc, doc.length - '</span>'.length, doc.length - '</span>'.length);
    v.focus();
    v.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(v.state.doc.toString()).toBe('- <span style="color:var(--brand-green)">two</span>\n- ');
    expect(literalSpanTags(v)).toBe(0);
  });
});
