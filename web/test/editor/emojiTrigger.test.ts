import { afterEach, describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { extendedSyntax } from '../../src/lib/editor/syntax';
import { livePreview } from '../../src/lib/editor/livePreview';
import { detectEmojiTrigger } from '../../src/lib/editor/emojiTrigger';

const md = () => markdown({ base: markdownLanguage, extensions: extendedSyntax });
const views: EditorView[] = [];
function makeEditor(doc: string, cursor: number): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, selection: EditorSelection.cursor(cursor), extensions: [md(), livePreview()] }),
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

describe('detectEmojiTrigger', () => {
  it('fires at line start with the query and the colon offset', () => {
    const v = makeEditor(':smi', 4);
    expect(detectEmojiTrigger(v.state)).toEqual({ from: 0, query: 'smi' });
  });

  it('fires after a space', () => {
    const v = makeEditor('hello :wav', 10);
    expect(detectEmojiTrigger(v.state)).toEqual({ from: 6, query: 'wav' });
  });

  it('does not fire mid-word (e.g. a URL scheme)', () => {
    const v = makeEditor('http://ex', 9);
    expect(detectEmojiTrigger(v.state)).toBeNull();
  });

  it('does not fire on a bare colon or a single char', () => {
    expect(detectEmojiTrigger(makeEditor('a :', 3).state)).toBeNull();
    expect(detectEmojiTrigger(makeEditor('a :s', 4).state)).toBeNull();
  });

  it('does not fire once the closing colon is typed', () => {
    const v = makeEditor(':smile:', 7);
    expect(detectEmojiTrigger(v.state)).toBeNull();
  });

  it('does not fire inside inline code', () => {
    const v = makeEditor('`:smi`', 5);
    expect(detectEmojiTrigger(v.state)).toBeNull();
  });

  it('returns null when there is a selection', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: ':smi', selection: EditorSelection.range(0, 4), extensions: [md(), livePreview()] }),
    });
    views.push(view);
    expect(detectEmojiTrigger(view.state)).toBeNull();
  });
});
