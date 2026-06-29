import { afterEach, describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { extendedSyntax } from '../../src/lib/editor/syntax';
import { indentListItem, outdentListItem } from '../../src/lib/editor/commands';

const md = () => markdown({ base: markdownLanguage, extensions: extendedSyntax });
const views: EditorView[] = [];
// Build an editor whose caret/selection is marked in `doc` by `|` (one = caret,
// two = selection). The markers are stripped before the doc is created.
function makeEditor(doc: string): EditorView {
  const marks: number[] = [];
  let text = '';
  for (const ch of doc) {
    if (ch === '|') marks.push(text.length);
    else text += ch;
  }
  const selection =
    marks.length === 2
      ? EditorSelection.single(marks[0]!, marks[1]!)
      : marks.length === 1
        ? EditorSelection.cursor(marks[0]!)
        : undefined;
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: text, selection, extensions: [md()] }),
  });
  views.push(view);
  return view;
}
afterEach(() => {
  for (const v of views.splice(0)) {
    v.dom.parentElement?.remove();
    v.destroy();
  }
});

describe('indentListItem (Tab)', () => {
  it('nests a bullet item under the item above it', () => {
    const v = makeEditor('- one\n- tw|o');
    expect(indentListItem(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('- one\n  - two');
  });

  it('aligns the nested marker to an ordered parent’s content column', () => {
    const v = makeEditor('1. one\n- tw|o');
    expect(indentListItem(v)).toBe(true);
    // "1. " is 3 wide, so the child indents by 3 to sit under "one".
    expect(v.state.doc.toString()).toBe('1. one\n   - two');
  });

  it('works regardless of caret column within the item', () => {
    const v = makeEditor('- one\n|- two');
    expect(indentListItem(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('- one\n  - two');
  });

  it('is a consumed no-op on the first item of a list (nothing to nest under)', () => {
    const v = makeEditor('- on|e');
    expect(indentListItem(v)).toBe(true); // consumes Tab…
    expect(v.state.doc.toString()).toBe('- one'); // …but changes nothing
  });

  it('does not over-nest past one level under the parent', () => {
    const v = makeEditor('- one\n  - tw|o');
    expect(indentListItem(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('- one\n  - two'); // already maximally nested
  });

  it('carries the item’s subtree along when nesting', () => {
    const v = makeEditor('- one\n- tw|o\n  - child');
    expect(indentListItem(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('- one\n  - two\n    - child');
  });

  it('continues nesting a third item under the second', () => {
    const v = makeEditor('- one\n  - two\n  - thre|e');
    expect(indentListItem(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('- one\n  - two\n    - three');
  });

  it('preserves task-list checkbox markers', () => {
    const v = makeEditor('- [ ] one\n- [x] tw|o');
    expect(indentListItem(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('- [ ] one\n  - [x] two');
  });

  it('falls through (returns false) outside a list', () => {
    const v = makeEditor('just a paragra|ph');
    expect(indentListItem(v)).toBe(false);
    expect(v.state.doc.toString()).toBe('just a paragraph');
  });

  it('indents every list item across a multi-line selection', () => {
    const v = makeEditor('- zero\n- |one\n- two|');
    expect(indentListItem(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('- zero\n  - one\n  - two');
  });
});

describe('outdentListItem (Shift-Tab)', () => {
  it('lifts a nested item back to its parent’s level', () => {
    const v = makeEditor('- one\n  - tw|o');
    expect(outdentListItem(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('- one\n- two');
  });

  it('is a consumed no-op at the top level', () => {
    const v = makeEditor('- on|e');
    expect(outdentListItem(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('- one');
  });

  it('carries the item’s subtree along when outdenting', () => {
    const v = makeEditor('- one\n  - tw|o\n    - child');
    expect(outdentListItem(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('- one\n- two\n  - child');
  });

  it('outdents to the nearest shallower ancestor, not all the way', () => {
    const v = makeEditor('- a\n  - b\n    - |c');
    expect(outdentListItem(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('- a\n  - b\n  - c');
  });

  it('round-trips with indent (Tab then Shift-Tab restores the source)', () => {
    const v = makeEditor('- one\n- tw|o');
    indentListItem(v);
    outdentListItem(v);
    expect(v.state.doc.toString()).toBe('- one\n- two');
  });

  it('falls through (returns false) outside a list', () => {
    const v = makeEditor('plain te|xt');
    expect(outdentListItem(v)).toBe(false);
  });
});
