import { afterEach, describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { extendedSyntax } from '../../src/lib/editor/syntax';
import { livePreview } from '../../src/lib/editor/livePreview';
import { applyColor } from '../../src/lib/editor/commands';

const md = () => markdown({ base: markdownLanguage, extensions: extendedSyntax });
const views: EditorView[] = [];
function mk(doc: string) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [md(), livePreview()] }) });
  views.push(view);
  return view;
}
const sel = (v: EditorView, a: number, b: number) => v.dispatch({ selection: EditorSelection.single(a, b) });
afterEach(() => {
  for (const v of views.splice(0)) { v.dom.parentElement?.remove(); v.destroy(); }
});

// Color *values* (passed to applyColor) and the open *tags* they produce.
const rv = 'var(--brand-red)';
const gv = 'var(--brand-green)';
const bv = 'var(--brand-blue)';
const tag = (v: string) => `<span style="color:${v}">`;
const C = (v: string, t: string) => `${tag(v)}${t}</span>`;

describe('coloring next to an existing colored run keeps them separate', () => {
  it('a selection that snaps onto the concealed open tag does not recolor the neighbour', () => {
    // "def" is red; visually selecting "c" runs up to "just before def" — which,
    // because the open tag is zero-width, lands *after* it in the document.
    const v = mk(`abc${C(rv, 'def')}`);
    const redContentStart = `abc${tag(rv)}`.length; // start of "def"
    sel(v, 2, redContentStart);
    applyColor(v, gv);
    expect(v.state.doc.toString()).toBe(`ab${C(gv, 'c')}${C(rv, 'def')}`);
  });

  it('selecting middle letters of a colored word recolors only those (splits the run)', () => {
    const v = mk(C(rv, 'abcdef'));
    const cs = tag(rv).length; // content start
    sel(v, cs + 2, cs + 4); // "cd"
    applyColor(v, gv);
    expect(v.state.doc.toString()).toBe(`${C(rv, 'ab')}${C(gv, 'cd')}${C(rv, 'ef')}`);
  });

  it('selecting the leading letters splits without an empty span', () => {
    const v = mk(C(rv, 'abcdef'));
    const cs = tag(rv).length;
    sel(v, cs, cs + 2); // "ab"
    applyColor(v, gv);
    expect(v.state.doc.toString()).toBe(`${C(gv, 'ab')}${C(rv, 'cdef')}`);
  });

  it('selecting the trailing letters splits without an empty span', () => {
    const v = mk(C(rv, 'abcdef'));
    const cs = tag(rv).length;
    sel(v, cs + 4, cs + 6); // "ef"
    applyColor(v, gv);
    expect(v.state.doc.toString()).toBe(`${C(rv, 'abcd')}${C(gv, 'ef')}`);
  });

  it('selecting the whole run (or a caret inside) recolors all of it', () => {
    const cs = tag(rv).length;
    const whole = mk(C(rv, 'abcdef'));
    sel(whole, cs, cs + 6);
    applyColor(whole, gv);
    expect(whole.state.doc.toString()).toBe(C(gv, 'abcdef'));

    const caret = mk(C(rv, 'abcdef'));
    sel(caret, cs + 3, cs + 3);
    applyColor(caret, gv);
    expect(caret.state.doc.toString()).toBe(C(gv, 'abcdef'));
  });

  it('every letter of a word can be a different color', () => {
    // Use X/Y/Z (absent from the lowercase markup) so indexOf finds the content.
    const v = mk('XYZ');
    sel(v, 2, 3);
    applyColor(v, rv); // XY<red>Z</span>
    sel(v, 1, v.state.doc.toString().indexOf('Z')); // "Y" up to the concealed red tag
    applyColor(v, gv);
    sel(v, 0, v.state.doc.toString().indexOf('Y')); // "X" up to the concealed green tag
    applyColor(v, bv);
    expect(v.state.doc.toString()).toBe(`${C(bv, 'X')}${C(gv, 'Y')}${C(rv, 'Z')}`);
  });
});
