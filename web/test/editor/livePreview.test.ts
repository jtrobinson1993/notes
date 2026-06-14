import { afterEach, describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
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

/** What the user actually sees: concealed (replaced) ranges drop out of the DOM. */
function visibleText(view: EditorView): string {
  return view.dom.querySelector('.cm-content')?.textContent ?? '';
}

afterEach(() => {
  for (const v of views.splice(0)) {
    v.dom.parentElement?.remove();
    v.destroy();
  }
});

describe('decoration building is robust', () => {
  it('builds over a doc mixing tasks and a table without disabling the plugin', () => {
    const doc = ['- [ ] one', '- [x] two', '', '| a | b |', '| - | - |', '| 1 | 2 |', ''].join('\n');
    const view = makeEditor(doc);
    // If RangeSet.of had thrown on a same-position side tiebreak, CM would have
    // disabled the plugin and neither widget would render.
    expect(view.dom.querySelectorAll('.cm-task-checkbox').length).toBe(2);
    expect(view.dom.querySelector('.cm-live-table')).not.toBeNull();
  });
});

describe('empty ATX heading keeps its marker (plugin not disabled)', () => {
  it('keeps "##" visible on an empty heading but conceals it on a real one', () => {
    // Empty heading: concealing would blank the line and break further typing,
    // so the marker stays on screen.
    expect(visibleText(makeEditor('##'))).toContain('##');
    // A populated heading conceals the "## " prefix entirely.
    expect(visibleText(makeEditor('## Title'))).not.toContain('#');
    expect(visibleText(makeEditor('## Title'))).toContain('Title');
  });
});

describe('task checkbox toggle', () => {
  it('flips [ ] → [x] when the rendered checkbox is clicked', () => {
    const view = makeEditor('- [ ] milk');
    const box = view.dom.querySelector<HTMLInputElement>('.cm-task-checkbox')!;
    expect(box.checked).toBe(false);
    box.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(view.state.doc.toString()).toBe('- [x] milk');
  });

  it('flips [x] → [ ] back again', () => {
    const view = makeEditor('- [x] milk');
    const box = view.dom.querySelector<HTMLInputElement>('.cm-task-checkbox')!;
    expect(box.checked).toBe(true);
    box.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(view.state.doc.toString()).toBe('- [ ] milk');
  });
});

describe('editable table', () => {
  it('committing a cell rewrites only that cell’s source range', () => {
    const doc = ['| a | b |', '| - | - |', '| 1 | 2 |'].join('\n');
    const view = makeEditor(doc);
    const inputs = view.dom.querySelectorAll<HTMLInputElement>('.cm-live-table input');
    // header: [a, b]; body: [1, 2].
    const cellB = [...inputs].find((i) => i.value === 'b')!;
    cellB.value = 'beta';
    cellB.dispatchEvent(new Event('blur'));
    expect(view.state.doc.toString()).toBe(['| a | beta |', '| - | - |', '| 1 | 2 |'].join('\n'));
  });
});

describe('concealedMotion', () => {
  it('an ArrowRight from the start lands on the first visible char, skipping the concealed "**"', () => {
    const view = makeEditor('**bold**');
    view.focus();
    view.dispatch({ selection: EditorSelection.cursor(0) });
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    // The caret starts visually before "b" (the "**" is concealed at offsets
    // 0-2). One press skips that dead zone AND moves one visible char, landing
    // after "b" at offset 3 — never stranded at offset 1 inside the markers.
    expect(view.state.selection.main.head).toBe(3);
  });
});
