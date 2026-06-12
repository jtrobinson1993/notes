import { syntaxTree } from '@codemirror/language';
import { EditorSelection, type EditorState } from '@codemirror/state';
import type { Command, KeyBinding } from '@codemirror/view';
import { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { COLOR_VALUE_RE } from './syntax';
import { setLastColor } from './palette';

// Wrap/unwrap formatting on the main selection. If the selection sits inside
// an existing node of the given type, the markers are removed (toggle off);
// otherwise the selection (or caret) is wrapped.

function findEnclosing(state: EditorState, name: string, from: number, to: number): SyntaxNode | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(from, 1);
  for (let p: SyntaxNode | null = node; p; p = p.parent) {
    if (p.name === name && p.from <= from && p.to >= to) return p;
  }
  return null;
}

function markerChildren(node: SyntaxNode): SyntaxNode[] {
  const marks: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (/(Mark|Tag)$/.test(child.name)) marks.push(child);
  }
  return marks;
}

function unwrap(view: EditorView, node: SyntaxNode): void {
  view.dispatch({
    changes: markerChildren(node).map((m) => ({ from: m.from, to: m.to, insert: '' })),
    userEvent: 'input.format',
  });
}

function toggleInline(name: string, open: string, close = open): Command {
  return (view) => {
    const range = view.state.selection.main;
    const node = findEnclosing(view.state, name, range.from, range.to);
    if (node) {
      unwrap(view, node);
    } else {
      view.dispatch({
        changes: [
          { from: range.from, insert: open },
          { from: range.to, insert: close },
        ],
        selection: { anchor: range.from + open.length, head: range.to + open.length },
        userEvent: 'input.format',
      });
    }
    view.focus();
    return true;
  };
}

export const toggleBold = toggleInline('StrongEmphasis', '**');
export const toggleItalic = toggleInline('Emphasis', '*');
export const toggleCode = toggleInline('InlineCode', '`');
export const toggleStrike = toggleInline('Strikethrough', '~~');
export const toggleHighlight = toggleInline('Highlight', '==');
export const toggleSpoilerSyntax = toggleInline('Spoiler', '||');
export const toggleUnderline = toggleInline('Underline', '<u>', '</u>');

export const insertLink: Command = (view) => {
  const range = view.state.selection.main;
  const existing = findEnclosing(view.state, 'Link', range.from, range.to);
  if (existing) return true; // already a link; let the user edit it in place
  const url = prompt('Link URL:');
  if (!url) return true;
  const text = view.state.sliceDoc(range.from, range.to);
  const insert = `[${text}](${url})`;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: range.from + 1, head: range.from + 1 + text.length },
    userEvent: 'input.format',
  });
  view.focus();
  return true;
};

// css must be a brand var() or light-dark() pair (validated; goes into an
// inline style attribute).
export function applyColor(view: EditorView, css: string): boolean {
  if (!COLOR_VALUE_RE.test(css)) return false;
  setLastColor(css);
  const range = view.state.selection.main;
  const node = findEnclosing(view.state, 'ColorSpan', range.from, range.to);
  if (node) {
    const openTag = markerChildren(node)[0];
    if (openTag) {
      view.dispatch({
        changes: { from: openTag.from, to: openTag.to, insert: `<span style="color:${css}">` },
        userEvent: 'input.format',
      });
    }
  } else {
    const open = `<span style="color:${css}">`;
    // selection: cursor lands inside an empty span (typed text is colored)
    // but after the closing tag when wrapping existing text, so the span
    // conceals immediately and typing continues uncolored
    const cursor = range.empty
      ? range.from + open.length
      : range.to + open.length + '</span>'.length;
    view.dispatch({
      changes: [
        { from: range.from, insert: open },
        { from: range.to, insert: '</span>' },
      ],
      selection: { anchor: cursor },
      userEvent: 'input.format',
    });
  }
  view.focus();
  return true;
}

export function clearColor(view: EditorView): boolean {
  const range = view.state.selection.main;
  const node = findEnclosing(view.state, 'ColorSpan', range.from, range.to);
  if (node) unwrap(view, node);
  view.focus();
  return true;
}

// Formatted-span detection for the selection toolbar: show it whenever the
// caret sits inside already-formatted text (or there is a selection).
const FORMAT_NODES = new Set([
  'StrongEmphasis',
  'Emphasis',
  'InlineCode',
  'Strikethrough',
  'Highlight',
  'Spoiler',
  'Underline',
  'ColorSpan',
  'Link',
]);

export function cursorInFormat(state: EditorState): boolean {
  const head = state.selection.main.head;
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(head, -1);
    node;
    node = node.parent
  ) {
    if (FORMAT_NODES.has(node.name)) return true;
  }
  return false;
}

// With markers always concealed, heading levels need a command: set the
// line's heading level (same level again toggles back to paragraph).
export function setHeading(level: number): Command {
  return (view) => {
    const tr = view.state.changeByRange((range) => {
      const line = view.state.doc.lineAt(range.head);
      const m = /^(#{1,6})\s+/.exec(line.text);
      const current = m ? m[1]!.length : 0;
      const target = current === level ? 0 : level;
      const prefix = target ? '#'.repeat(target) + ' ' : '';
      const removeLen = m ? m[0].length : 0;
      const delta = prefix.length - removeLen;
      return {
        changes: { from: line.from, to: line.from + removeLen, insert: prefix },
        range: EditorSelection.cursor(Math.max(line.from + prefix.length, range.head + delta)),
      };
    });
    view.dispatch(tr, { userEvent: 'input.format' });
    view.focus();
    return true;
  };
}

// Line-boundary deletes that ignore atomic concealed markers: the stock
// deleteLineBoundaryBackward stops at the atomic boundary, which strands a
// hidden opening tag (e.g. a color <span …>) whose mate was just deleted.
const deleteToLineStart: Command = (view) => {
  const tr = view.state.changeByRange((range) => {
    const line = view.state.doc.lineAt(range.head);
    if (range.head === line.from) return { range };
    return {
      changes: { from: line.from, to: range.head },
      range: EditorSelection.cursor(line.from),
    };
  });
  if (tr.changes.empty) return false;
  view.dispatch(tr, { scrollIntoView: true, userEvent: 'delete' });
  return true;
};

const deleteToLineEnd: Command = (view) => {
  const tr = view.state.changeByRange((range) => {
    const line = view.state.doc.lineAt(range.head);
    if (range.head === line.to) return { range };
    return {
      changes: { from: range.head, to: line.to },
      range: EditorSelection.cursor(range.head),
    };
  });
  if (tr.changes.empty) return false;
  view.dispatch(tr, { scrollIntoView: true, userEvent: 'delete' });
  return true;
};

export const formattingKeymap: KeyBinding[] = [
  { key: 'Mod-b', run: toggleBold, preventDefault: true },
  { key: 'Mod-i', run: toggleItalic, preventDefault: true },
  { key: 'Mod-u', run: toggleUnderline, preventDefault: true },
  { key: 'Mod-e', run: toggleCode, preventDefault: true },
  { key: 'Mod-Shift-h', run: toggleHighlight, preventDefault: true },
  { key: 'Mod-Shift-x', run: toggleStrike, preventDefault: true },
  { key: 'Mod-k', run: insertLink, preventDefault: true },
  { key: 'Mod-Backspace', run: deleteToLineStart, preventDefault: true },
  { key: 'Mod-Delete', run: deleteToLineEnd, preventDefault: true },
  ...[1, 2, 3, 4, 5, 6].map((level) => ({
    key: `Mod-Shift-${level}`,
    run: setHeading(level),
    preventDefault: true,
  })),
  { key: 'Mod-Shift-0', run: setHeading(0), preventDefault: true },
];
