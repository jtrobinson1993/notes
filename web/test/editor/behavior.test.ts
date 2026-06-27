import { afterEach, describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { extendedSyntax } from '../../src/lib/editor/syntax';
import { livePreview } from '../../src/lib/editor/livePreview';
import { inListItem } from '../../src/lib/editor/commands';

const md = () => markdown({ base: markdownLanguage, extensions: extendedSyntax });
const views: EditorView[] = [];
function makeEditor(doc: string, cursor?: number): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    selection: cursor != null ? EditorSelection.cursor(cursor) : undefined,
    extensions: [md(), livePreview()],
  });
  const view = new EditorView({ parent, state });
  views.push(view);
  return view;
}
afterEach(() => {
  for (const v of views.splice(0)) {
    v.dom.parentElement?.remove();
    v.destroy();
  }
});

describe('whitespace breakout', () => {
  it('relocates a space typed just before the closing markers to after them', () => {
    const v = makeEditor('**bold**');
    v.dispatch({ changes: { from: 6, insert: ' ' }, userEvent: 'input.type' });
    // The space can't sit inside the emphasis (it would break the markup), so
    // it moves past the closing "**".
    expect(v.state.doc.toString()).toBe('**bold** ');
  });

  it('leaves a space typed in normal text alone', () => {
    const v = makeEditor('**bold**');
    v.dispatch({ changes: { from: 2, insert: ' ' }, userEvent: 'input.type' });
    expect(v.state.doc.toString()).toBe('** bold**');
  });
});

describe('newline breakout', () => {
  it('relocates a newline before closing markers to after them', () => {
    const v = makeEditor('**bold**');
    v.dispatch({ changes: { from: 6, insert: '\n' }, userEvent: 'input' });
    expect(v.state.doc.toString()).toBe('**bold**\n');
  });

  // Regression: a caret *past* the close marker (after the colored text) is
  // outside the span — Enter there must be a plain newline, not a split that
  // strands a duplicate "</span>" and reopens an empty span on the next line.
  const span = '<span style="color:var(--brand-purple)">text</span>';
  it('inserts a plain newline after a color span (caret past </span>)', () => {
    const v = makeEditor(span);
    v.dispatch({ changes: { from: span.length, insert: '\n' }, userEvent: 'input' });
    expect(v.state.doc.toString()).toBe(`${span}\n`);
  });

  it('relocates a newline from just before </span> to after it', () => {
    const v = makeEditor(span);
    v.dispatch({ changes: { from: span.length - '</span>'.length, insert: '\n' }, userEvent: 'input' });
    expect(v.state.doc.toString()).toBe(`${span}\n`);
  });

  it('still splits the span when the newline lands mid-content', () => {
    const v = makeEditor(span);
    const mid = '<span style="color:var(--brand-purple)">te'.length;
    v.dispatch({ changes: { from: mid, insert: '\n' }, userEvent: 'input' });
    expect(v.state.doc.toString()).toBe(
      '<span style="color:var(--brand-purple)">te</span>\n<span style="color:var(--brand-purple)">xt</span>',
    );
  });
});

describe('inListItem (chat composer Enter = continue list)', () => {
  it('is true when the caret sits inside a bullet list item', () => {
    const v = makeEditor('- one', 5); // caret at end of "- one"
    expect(inListItem(v.state)).toBe(true);
  });

  it('is true inside an ordered list item', () => {
    const v = makeEditor('1. one', 6);
    expect(inListItem(v.state)).toBe(true);
  });

  it('is false in a plain paragraph', () => {
    const v = makeEditor('just text', 4);
    expect(inListItem(v.state)).toBe(false);
  });
});

describe('backspace at the end of formatted text deletes a letter, not the markup', () => {
  const backspace = (v: EditorView) =>
    v.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));

  it('keeps a color span intact when backspacing right after </span>', () => {
    const doc = '<span style="color:var(--brand-purple)">abc</span>';
    const v = makeEditor(doc, doc.length); // caret after the concealed </span>
    backspace(v);
    expect(v.state.doc.toString()).toBe('<span style="color:var(--brand-purple)">ab</span>');
  });

  it('keeps an underline span intact too', () => {
    const v = makeEditor('<u>abc</u>', '<u>abc</u>'.length);
    backspace(v);
    expect(v.state.doc.toString()).toBe('<u>ab</u>');
  });

  it('removes the whole span (markers + content) when its last letter is backspaced', () => {
    const doc = '<span style="color:var(--brand-purple)">ab</span>';
    const v = makeEditor(doc, doc.length);
    backspace(v); // 'b' → keep formatting
    expect(v.state.doc.toString()).toBe('<span style="color:var(--brand-purple)">a</span>');
    backspace(v); // last 'a' → tags go with it, nothing orphaned
    expect(v.state.doc.toString()).toBe('');
  });

  it('does not intercept plain text (no formatted container at the caret)', () => {
    const v = makeEditor('plain', 5);
    backspace(v); // smartBackspace returns false → default handles it (real editor)
    expect(v.state.doc.toString()).toBe('plain'); // unchanged here: no defaultKeymap in this test editor
  });
});

describe('spoiler reveal while the cursor is inside', () => {
  it('reveals the spoiler content when the selection touches it', () => {
    const v = makeEditor('a ||secret|| b');
    // Cursor outside the spoiler → concealed.
    v.dispatch({ selection: EditorSelection.cursor(0) });
    expect(v.dom.querySelector('.cm-spoiler-revealed')).toBeNull();
    // Cursor inside the spoiler → revealed.
    v.dispatch({ selection: EditorSelection.cursor(6) });
    expect(v.dom.querySelector('.cm-spoiler-revealed')).not.toBeNull();
  });
});
