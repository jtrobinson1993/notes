import { afterEach, describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { extendedSyntax } from '../../src/lib/editor/syntax';
import { livePreview } from '../../src/lib/editor/livePreview';
import { applyColor, toggleBold, toggleHighlight, hopPastTrailingCloseTags } from '../../src/lib/editor/commands';
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown';

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

// Regression: the closing marker must not land within a *later* list item's
// leading markup either — selecting a whole list line including its trailing
// newline used to push "</span>" ahead of the next line's "- ", stripping it.
describe('inline wrap never pushes its close into the next list item', () => {
  const bullets = (v: EditorView) => v.dom.querySelectorAll('.cm-live-bullet').length;
  // "- one\n- two": line1 [0,5], newline at 5, line2 [6,11]
  it('color over line 1 including the newline keeps line 2 a list item', () => {
    const v = makeEditor('- one\n- two', 0, 6);
    applyColor(v, 'var(--brand-red)');
    expect(v.state.doc.toString()).toBe('- <span style="color:var(--brand-red)">one</span>\n- two');
    expect(bullets(v)).toBe(2);
  });

  it('works the same for a reversed selection', () => {
    const v = makeEditor('- one\n- two', 6, 0);
    applyColor(v, 'var(--brand-red)');
    expect(v.state.doc.toString()).toBe('- <span style="color:var(--brand-red)">one</span>\n- two');
    expect(bullets(v)).toBe(2);
  });

  it('bold over line 1 including the newline keeps line 2 a list item', () => {
    const v = makeEditor('- one\n- two', 0, 6);
    toggleBold(v);
    expect(v.state.doc.toString()).toBe('- **one**\n- two');
    expect(bullets(v)).toBe(2);
  });

  it('a selection ending mid-next-line wraps each item separately', () => {
    const v = makeEditor('- one\n- two', 0, 9); // through "- t" on line 2
    applyColor(v, 'var(--brand-red)');
    // One span per line — never a single span crossing the list-item boundary
    // (which would un-render and strand raw tags).
    expect(v.state.doc.toString()).toBe(
      '- <span style="color:var(--brand-red)">one</span>\n- <span style="color:var(--brand-red)">t</span>wo',
    );
    expect(bullets(v)).toBe(2);
  });
});

describe('Enter keeps trailing close-tags on the current line', () => {
  it('hops the caret past a trailing </span> so continuing a list does not split it', () => {
    const doc = '- <span style="color:var(--brand-red)">text</span>';
    const at = doc.length - '</span>'.length; // caret right before the close tag
    const v = makeEditor(doc, at, at);
    hopPastTrailingCloseTags(v);
    insertNewlineContinueMarkup(v);
    expect(v.state.doc.toString()).toBe('- <span style="color:var(--brand-red)">text</span>\n- ');
  });

  it('is a no-op when the caret is not before a trailing close-tag', () => {
    const v = makeEditor('- hello', 4, 4);
    expect(hopPastTrailingCloseTags(v)).toBe(false);
    expect(v.state.selection.main.head).toBe(4);
  });
});
