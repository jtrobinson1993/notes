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

// Leading block markup on a line: indentation, then any stack of list markers
// ("- ", "* ", "1. ") and blockquote markers ("> "). Inline wrapping must begin
// after this, never inside it — wrapping the "- " into a <span>…</span> / **…**
// turns the line into plain text and strips its list (or quote) styling.
const LEADING_BLOCK_MARKUP = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+|>[ \t]?)*/;
function lineContentStart(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos);
  return line.from + LEADING_BLOCK_MARKUP.exec(line.text)![0].length;
}

/** Where an inline wrap's opening marker should go: `from`, but clamped forward
 *  past the start line's leading list/quote markup so the wrap can't swallow it
 *  (which would drop the line's list/quote styling), and never past `to`. */
function wrapOpenPos(state: EditorState, from: number, to: number): number {
  return Math.min(Math.max(from, lineContentStart(state, from)), to);
}

/** Where an inline wrap's closing marker should go: `to`, but pulled back so it
 *  never lands within (or before) a *later* line's leading list/quote markup —
 *  which would shove the close marker ahead of that line's "- "/"> " and strip
 *  its styling (the common "selected the whole line incl. its newline" case).
 *  Stays within `[from, to]`. */
function wrapClosePos(state: EditorState, from: number, to: number): number {
  let pos = to;
  while (pos > from) {
    const line = state.doc.lineAt(pos);
    // Real content precedes `pos` on its line → a fine place to close.
    if (pos > lineContentStart(state, pos)) break;
    // `pos` sits in (or before) this line's leading markup; drop back to the end
    // of the previous line's content (past the newline + that markup).
    if (line.number === 1) return from;
    pos = Math.max(from, state.doc.line(line.number - 1).to);
  }
  return pos;
}

/** Keep a wrap range from snapping *into* an adjacent existing `ColorSpan`. The
 *  concealed open/close markers are zero-width, so a visual selection next to a
 *  colored run can land on the run's marker (its content edge); wrapping that
 *  would swallow the marker and recolor the neighbour. Pull each endpoint back
 *  outside any span it only partially covers from the outside. */
function clampOutOfAdjacentSpans(state: EditorState, from: number, to: number): { from: number; to: number } {
  const tree = syntaxTree(state);
  // `to` landed inside a span that starts at/after `from` → end before it.
  for (let n: SyntaxNode | null = tree.resolveInner(to, -1); n; n = n.parent) {
    if (n.name === 'ColorSpan' && from <= n.from && n.from < to && to < n.to) {
      to = n.from;
      break;
    }
  }
  // `from` landed inside a span that ends at/before `to` → start after it.
  for (let n: SyntaxNode | null = tree.resolveInner(from, 1); n; n = n.parent) {
    if (n.name === 'ColorSpan' && n.to <= to && from < n.to && n.from < from) {
      from = n.to;
      break;
    }
  }
  return { from, to };
}

function findEnclosing(state: EditorState, name: string, from: number, to: number): SyntaxNode | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(from, 1);
  for (let p: SyntaxNode | null = node; p; p = p.parent) {
    if (p.name === name && p.from <= from && p.to >= to) return p;
  }
  return null;
}

/** If everything from the caret to the end of its line is concealed inline
 *  markup — a span/underline/emphasis `*Tag`/`*Mark`, with the caret possibly
 *  part-way through one (a click can land the caret inside a concealed, atomic
 *  close tag) — move the caret to the line end. Returns whether it moved.
 *  Called before a list-continuing Enter so the newline can't split a marker or
 *  strand the close tags on the new item (which orphans the color/underline).
 *  A no-op when real content sits between the caret and the line end. */
export function hopPastTrailingCloseTags(view: EditorView): boolean {
  const r = view.state.selection.main;
  if (!r.empty) return false;
  const line = view.state.doc.lineAt(r.head);
  if (r.head >= line.to) return false;
  const tree = syntaxTree(view.state);
  let pos = r.head;
  while (pos < line.to) {
    let marker: SyntaxNode | null = null;
    for (let n: SyntaxNode | null = tree.resolveInner(pos, 1); n; n = n.parent) {
      if (/(Mark|Tag)$/.test(n.name) && n.from <= pos && n.to > pos) {
        marker = n;
        break;
      }
    }
    if (!marker) return false; // real content before the line end → don't hop
    pos = marker.to;
  }
  view.dispatch({ selection: { anchor: line.to } });
  return true;
}

/** True when the caret sits inside a markdown list item (bullet or ordered).
 *  Used by the chat composer so Enter continues the list instead of sending. */
export function inListItem(state: EditorState): boolean {
  const head = state.selection.main.head;
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(head, -1); n; n = n.parent) {
    if (n.name === 'ListItem' || n.name === 'BulletList' || n.name === 'OrderedList') return true;
  }
  return false;
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
      const openPos = wrapOpenPos(view.state, range.from, range.to);
      const closePos = wrapClosePos(view.state, openPos, range.to);
      view.dispatch({
        changes: [
          { from: openPos, insert: open },
          { from: closePos, insert: close },
        ],
        selection: { anchor: openPos + open.length, head: closePos + open.length },
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
  const from = wrapOpenPos(view.state, range.from, range.to);
  const to = wrapClosePos(view.state, from, range.to);
  const text = view.state.sliceDoc(from, to);
  const insert = `[${text}](${url})`;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + 1, head: from + 1 + text.length },
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
  const open = `<span style="color:${css}">`;
  const enclosing = findEnclosing(view.state, 'ColorSpan', range.from, range.to);
  if (enclosing) {
    const marks = markerChildren(enclosing);
    const openMark = marks[0];
    const closeMark = marks[marks.length - 1];
    if (openMark && closeMark && openMark !== closeMark) {
      if (range.empty || (range.from <= openMark.to && range.to >= closeMark.from)) {
        // A caret inside the run, or a selection covering all of it → recolor the
        // whole run by swapping its open tag's color (selection maps through).
        view.dispatch({
          changes: { from: openMark.from, to: openMark.to, insert: open },
          userEvent: 'input.format',
        });
      } else {
        // A partial selection inside the run → split it, so only the selected
        // letters take the new color and the rest keep the original.
        const doc = view.state.doc;
        const origOpen = doc.sliceString(openMark.from, openMark.to);
        const selFrom = Math.max(openMark.to, range.from);
        const selTo = Math.min(closeMark.from, range.to);
        const before = doc.sliceString(openMark.to, selFrom);
        const middle = doc.sliceString(selFrom, selTo);
        const after = doc.sliceString(selTo, closeMark.from);
        const rebuilt =
          (before ? `${origOpen}${before}</span>` : '') +
          `${open}${middle}</span>` +
          (after ? `${origOpen}${after}</span>` : '');
        const midStart =
          enclosing.from + (before ? origOpen.length + before.length + '</span>'.length : 0) + open.length;
        view.dispatch({
          changes: { from: enclosing.from, to: enclosing.to, insert: rebuilt },
          selection: { anchor: midStart, head: midStart + middle.length },
          userEvent: 'input.format',
        });
      }
    }
  } else if (range.empty) {
    // cursor lands inside the empty span so typed text is colored
    view.dispatch({
      changes: [
        { from: range.from, insert: open },
        { from: range.to, insert: '</span>' },
      ],
      selection: { anchor: range.from + open.length },
      userEvent: 'input.format',
    });
  } else {
    // Strip any color spans inside the selection, then wrap the selected content
    // of EACH line separately. An inline span can't cross a list/quote item (or
    // any block) boundary, so one span per line keeps every selected item colored
    // and valid — instead of a single span that strands raw <span>/</span> tags
    // across the items. Per line the wrap also skips leading list/quote markup.
    const state = view.state;
    // Keep the selection from snapping onto a neighbouring colored run's
    // concealed (zero-width) marker, which would swallow it and recolor it.
    const span = clampOutOfAdjacentSpans(state, range.from, range.to);
    const stripped: { from: number; to: number; insert: string }[] = [];
    syntaxTree(state).iterate({
      from: span.from,
      to: span.to,
      enter: (n) => {
        if (n.name === 'ColorSpan' && n.from >= span.from && n.to <= span.to) {
          for (const m of markerChildren(n.node)) stripped.push({ from: m.from, to: m.to, insert: '' });
        }
      },
    });
    const wraps: { from: number; to: number }[] = [];
    const firstLine = state.doc.lineAt(span.from).number;
    const lastLine = state.doc.lineAt(span.to).number;
    for (let ln = firstLine; ln <= lastLine; ln++) {
      const line = state.doc.line(ln);
      const from = Math.max(span.from, lineContentStart(state, line.from));
      const to = Math.min(span.to, line.to);
      if (to > from) wraps.push({ from, to });
    }
    if (wraps.length) {
      const changes = state.changes([
        ...stripped,
        ...wraps.flatMap((w) => [
          { from: w.from, insert: open },
          { from: w.to, insert: '</span>' },
        ]),
      ]);
      view.dispatch({
        changes,
        selection: {
          anchor: changes.mapPos(wraps[0]!.from, 1),
          head: changes.mapPos(wraps[wraps.length - 1]!.to, -1),
        },
        userEvent: 'input.format',
      });
    }
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

// Paired inline-wrap spans whose markers must be removed along with their
// content (Link excluded — its markers aren't a simple symmetric pair).
const WRAP_SPAN_NODES = new Set([
  'StrongEmphasis',
  'Emphasis',
  'InlineCode',
  'Strikethrough',
  'Highlight',
  'Spoiler',
  'Underline',
  'ColorSpan',
]);

/** Grow `[from, to]` to also cover the **markers** of any inline-wrap span whose
 *  *content* the range already fully covers. Used before replacing a selection
 *  (e.g. with a newline on Enter): deleting just the content would strand empty
 *  `<span></span>` / `**` markers, so we delete the whole construct instead. */
export function expandOverCoveredSpans(state: EditorState, from: number, to: number): { from: number; to: number } {
  let lo = from;
  let hi = to;
  syntaxTree(state).iterate({
    from,
    to,
    enter: (n) => {
      if (!WRAP_SPAN_NODES.has(n.name)) return;
      const marks = markerChildren(n.node);
      if (marks.length < 2) return;
      const open = marks[0]!;
      const close = marks[marks.length - 1]!;
      // The span's content sits between its markers; if the selection already
      // covers all of it, swallow the markers too.
      if (from <= open.to && to >= close.from) {
        lo = Math.min(lo, n.from);
        hi = Math.max(hi, n.to);
      }
    },
  });
  return { from: lo, to: hi };
}

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
