import { afterEach, describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { extendedSyntax } from '../../src/lib/editor/syntax';
import { livePreview } from '../../src/lib/editor/livePreview';

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
