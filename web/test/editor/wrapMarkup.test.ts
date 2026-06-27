import { afterEach, describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { extendedSyntax } from '../../src/lib/editor/syntax';
import { livePreview } from '../../src/lib/editor/livePreview';
import { applyColor, toggleBold, toggleHighlight } from '../../src/lib/editor/commands';

// Regression: selecting a whole list/quote line and applying an inline format
// (color span, bold, …) used to wrap the leading "- "/"> " marker into the
// span — e.g. `<span …>- item</span>` — which made the line stop being a list
// item, dropping its bullet. The wrap must start after the line's block markup.

const md = () => markdown({ base: markdownLanguage, extensions: extendedSyntax });
const views: EditorView[] = [];
function makeEditor(doc: string, anchor: number, head: number): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(anchor, head),
      extensions: [md(), livePreview()],
    }),
  });
  views.push(view);
  return view;
}
const bullets = (v: EditorView) => v.dom.querySelectorAll('.cm-live-bullet').length;

afterEach(() => {
  for (const v of views.splice(0)) {
    v.dom.parentElement?.remove();
    v.destroy();
  }
});

describe('inline wrap never swallows leading list/quote markup', () => {
  it('color over a full bullet line keeps the marker and the rendered bullet', () => {
    const v = makeEditor('- item', 0, 6);
    applyColor(v, 'var(--brand-red)');
    expect(v.state.doc.toString()).toBe('- <span style="color:var(--brand-red)">item</span>');
    expect(bullets(v)).toBe(1);
  });

  it('color over a full ordered-list line keeps the "1." marker', () => {
    const v = makeEditor('1. item', 0, 7);
    applyColor(v, 'var(--brand-red)');
    expect(v.state.doc.toString()).toBe('1. <span style="color:var(--brand-red)">item</span>');
  });

  it('color over a blockquote line keeps the ">" marker', () => {
    const v = makeEditor('> quote', 0, 7);
    applyColor(v, 'var(--brand-red)');
    expect(v.state.doc.toString()).toBe('> <span style="color:var(--brand-red)">quote</span>');
  });

  it('bold over a full bullet line keeps the marker', () => {
    const v = makeEditor('- item', 0, 6);
    toggleBold(v);
    expect(v.state.doc.toString()).toBe('- **item**');
    expect(bullets(v)).toBe(1);
  });

  it('highlight over a full bullet line keeps the marker', () => {
    const v = makeEditor('- item', 0, 6);
    toggleHighlight(v);
    expect(v.state.doc.toString()).toBe('- ==item==');
  });

  it('selecting only the word (not the marker) is unaffected', () => {
    const v = makeEditor('- item', 2, 6);
    applyColor(v, 'var(--brand-red)');
    expect(v.state.doc.toString()).toBe('- <span style="color:var(--brand-red)">item</span>');
  });

  it('a plain paragraph still wraps from the selection start', () => {
    const v = makeEditor('hello world', 0, 5);
    toggleBold(v);
    expect(v.state.doc.toString()).toBe('**hello** world');
  });
});
