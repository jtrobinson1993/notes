import { cursorCharLeft, cursorCharRight, selectCharLeft, selectCharRight } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import { EditorState, Prec, RangeSet, StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, keymap, ViewPlugin, type ViewUpdate, WidgetType, type Command } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { colorFromOpenTag } from './syntax';
import { attachmentResolver, EmbedWidget, ImageWidget, parseVideoUrl } from './media';

// WYSIWYG live preview: markers are always concealed — formatting is
// applied/removed via shortcuts and the selection toolbar, and raw markup is
// edited in source mode. Typed markdown still auto-renders (the document is
// markdown underneath); it just never un-renders at the cursor. Concealed
// ranges are atomic so the cursor skips over invisible syntax. Spoiler
// *content* still un-blurs while the cursor is inside (editing it blind
// would be worse).

// ---- spoiler reveal state ------------------------------------------------

interface Span {
  from: number;
  to: number;
}

export const toggleSpoiler = StateEffect.define<Span>({
  map: (v, ch) => ({ from: ch.mapPos(v.from), to: ch.mapPos(v.to) }),
});

export const revealedSpoilers = StateField.define<Span[]>({
  create: () => [],
  update(value, tr) {
    let spans = tr.docChanged
      ? value.map((s) => ({ from: tr.changes.mapPos(s.from), to: tr.changes.mapPos(s.to, 1) }))
      : value;
    for (const e of tr.effects) {
      if (!e.is(toggleSpoiler)) continue;
      const hit = spans.findIndex((s) => s.from <= e.value.to && s.to >= e.value.from);
      spans = hit >= 0 ? spans.toSpliced(hit, 1) : [...spans, e.value];
    }
    return spans;
  },
});

function isRevealed(state: EditorState, from: number, to: number): boolean {
  return state.field(revealedSpoilers).some((s) => s.from <= to && s.to >= from);
}

// ---- small widgets -------------------------------------------------------

class BulletWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    // the dot itself is a ::before pseudo-element (see .cm-live-bullet css)
    const el = document.createElement('span');
    el.className = 'cm-live-bullet';
    return el;
  }
}

class HrWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-live-hr';
    return el;
  }
}

const bulletWidget = new BulletWidget();
const hrWidget = new HrWidget();

// ---- decoration builder --------------------------------------------------

const hide = Decoration.replace({});

const headingMarks = [
  Decoration.mark({ class: 'cm-live-h1' }),
  Decoration.mark({ class: 'cm-live-h2' }),
  Decoration.mark({ class: 'cm-live-h3' }),
  Decoration.mark({ class: 'cm-live-h4' }),
  Decoration.mark({ class: 'cm-live-h5' }),
  Decoration.mark({ class: 'cm-live-h6' }),
];

const inlineMarks: Record<string, Decoration> = {
  StrongEmphasis: Decoration.mark({ class: 'cm-live-strong' }),
  Emphasis: Decoration.mark({ class: 'cm-live-em' }),
  InlineCode: Decoration.mark({ class: 'cm-live-code' }),
  Strikethrough: Decoration.mark({ class: 'cm-live-strike' }),
  Highlight: Decoration.mark({ class: 'cm-live-highlight' }),
  Underline: Decoration.mark({ class: 'cm-live-underline' }),
  Link: Decoration.mark({ class: 'cm-live-link' }),
};

const quoteLine = Decoration.line({ class: 'cm-live-quote' });

// Marker nodes that are always concealed.
const HIDDEN_MARKS: Record<string, true> = {
  EmphasisMark: true,
  CodeMark: true,
  StrikethroughMark: true,
  HighlightMark: true,
  SpoilerMark: true,
  UnderlineTag: true,
  ColorSpanTag: true,
  LinkMark: true,
};

function selTouches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

interface BuiltDecorations {
  decorations: DecorationSet;
  // hidden/replaced ranges; atomic for cursor movement
  atomics: RangeSet<Decoration>;
}

function buildDecorations(view: EditorView): BuiltDecorations {
  const ranges: Range<Decoration>[] = [];
  const hidden: Range<Decoration>[] = [];
  const state = view.state;
  const resolver = state.facet(attachmentResolver);

  const conceal = (from: number, to: number, deco: Decoration = hide) => {
    if (to > from) {
      ranges.push(deco.range(from, to));
      hidden.push(hide.range(from, to));
    }
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        const name = node.name;

        // Fenced code gets its chrome from the codeBlocks extension; skip
        // children so inline rules never fire inside code.
        if (name === 'FencedCode' || name === 'CodeBlock') return false;

        if (name.startsWith('ATXHeading')) {
          const level = Number(name.slice('ATXHeading'.length));
          if (level >= 1 && level <= 6) ranges.push(headingMarks[level - 1]!.range(node.from, node.to));
          return;
        }

        if (name === 'HeaderMark') {
          // keep the marker visible while the heading is empty ("##" alone):
          // concealing it would blank the line, and text typed after the
          // hidden marker would produce "##text", which isn't a heading
          const heading = node.node.parent;
          if (heading?.name.startsWith('ATXHeading') && heading.to <= node.to) return;
          // hide "# " including the following space
          conceal(node.from, Math.min(node.to + 1, state.doc.lineAt(node.from).to));
          return;
        }

        if (name in HIDDEN_MARKS) {
          conceal(node.from, node.to);
          return;
        }

        // \_ \* etc: show only the literal character
        if (name === 'Escape') {
          conceal(node.from, node.from + 1);
          return;
        }

        if (name in inlineMarks) {
          ranges.push(inlineMarks[name]!.range(node.from, node.to));
          return;
        }

        if (name === 'Spoiler') {
          // content reveals while the cursor is inside (so it stays editable)
          // or after a click; the || markers stay hidden regardless
          const revealed = isRevealed(state, node.from, node.to) || selTouches(state, node.from, node.to);
          ranges.push(
            Decoration.mark({ class: revealed ? 'cm-live-spoiler cm-spoiler-revealed' : 'cm-live-spoiler' }).range(
              node.from,
              node.to,
            ),
          );
          return;
        }

        if (name === 'ColorSpan') {
          const openTag = state.doc.sliceString(node.from, Math.min(node.to, node.from + 100));
          const color = colorFromOpenTag(openTag);
          if (color) ranges.push(Decoration.mark({ attributes: { style: `color:${color}` } }).range(node.from, node.to));
          return;
        }

        if (name === 'URL') {
          if (node.node.parent?.name === 'Link') conceal(node.from, node.to);
          return;
        }

        if (name === 'Image') {
          const text = state.doc.sliceString(node.from, node.to);
          const m = /^!\[([^\]]*)\]\(([^)\s]+)[^)]*\)$/.exec(text);
          if (!m) return;
          const spoiler = hasAncestor(node.node, 'Spoiler');
          conceal(
            node.from,
            node.to,
            Decoration.replace({ widget: new ImageWidget(m[2]!, m[1] ?? '', spoiler, resolver) }),
          );
          return false;
        }

        if (name === 'Autolink') {
          const url = state.doc.sliceString(node.from, node.to).replace(/^<|>$/g, '');
          const embed = parseVideoUrl(url);
          if (embed) {
            conceal(node.from, node.to, Decoration.replace({ widget: new EmbedWidget(embed) }));
            return false;
          }
          return;
        }

        if (name === 'Blockquote') {
          const first = state.doc.lineAt(node.from).number;
          const last = state.doc.lineAt(node.to).number;
          for (let l = first; l <= last; l++) ranges.push(quoteLine.range(state.doc.line(l).from));
          return;
        }

        if (name === 'QuoteMark') {
          const end = state.doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
          conceal(node.from, end);
          return;
        }

        if (name === 'ListMark') {
          const text = state.doc.sliceString(node.from, node.to);
          if (/^[-*+]$/.test(text) && node.node.parent?.parent?.name !== 'Task')
            conceal(node.from, node.to, Decoration.replace({ widget: bulletWidget }));
          return;
        }

        if (name === 'HorizontalRule') {
          conceal(node.from, node.to, Decoration.replace({ widget: hrWidget }));
          return;
        }

        return;
      },
    });
  }

  // RangeSet.of needs ranges ordered by from, then startSide — same-position
  // pairs with mismatched sides (e.g. a style mark and a concealment over an
  // identical range) throw otherwise, which kills the whole plugin
  const sort = (rs: Range<Decoration>[]) =>
    rs.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide || a.to - b.to);
  return {
    decorations: RangeSet.of(sort(ranges), false),
    atomics: RangeSet.of(sort(hidden), false),
  };
}

function hasAncestor(node: SyntaxNode, name: string): boolean {
  for (let p = node.parent; p; p = p.parent) if (p.name === name) return true;
  return false;
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    atomics: RangeSet<Decoration>;

    constructor(view: EditorView) {
      ({ decorations: this.decorations, atomics: this.atomics } = buildDecorations(view));
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.transactions.some((tr) => tr.effects.some((e) => e.is(toggleSpoiler))) ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      )
        ({ decorations: this.decorations, atomics: this.atomics } = buildDecorations(update.view));
    }
  },
  {
    decorations: (v) => v.decorations,
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomics ?? RangeSet.empty),
  },
);

// Concealed markers are atomic, but the positions on either side of one
// render at the same visual spot — a plain arrow step across a marker looks
// like the caret didn't move (one "dead" press at every span edge). Repeat
// the motion until the caret moves somewhere visible.

function coveredByConcealed(view: EditorView, a: number, b: number): boolean {
  if (a === b) return false;
  const atoms = view.plugin(livePreviewPlugin)?.atomics;
  if (!atoms) return false;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  let pos = lo;
  const iter = atoms.iter(lo);
  while (iter.value && iter.from < hi) {
    if (iter.from <= pos && iter.to > pos) pos = iter.to;
    iter.next();
  }
  return pos >= hi;
}

function visibleStep(cmd: Command, extend: boolean): Command {
  return (view) => {
    let prev = view.state.selection.main;
    if (!cmd(view)) return false;
    // collapsing a non-empty selection is the whole action — don't repeat
    if (!extend && !prev.empty) return true;
    for (let guard = 0; guard < 10; guard++) {
      const cur = view.state.selection.main;
      if (!coveredByConcealed(view, prev.head, cur.head)) break;
      prev = cur;
      if (!cmd(view) || view.state.selection.main.head === cur.head) break;
    }
    return true;
  };
}

const concealedMotion = Prec.high(
  keymap.of([
    { key: 'ArrowLeft', run: visibleStep(cursorCharLeft, false) },
    { key: 'ArrowRight', run: visibleStep(cursorCharRight, false) },
    { key: 'Shift-ArrowLeft', run: visibleStep(selectCharLeft, true) },
    { key: 'Shift-ArrowRight', run: visibleStep(selectCharRight, true) },
  ]),
);

// Clicking a concealed spoiler reveals it instead of placing the cursor;
// cmd/ctrl+clicking a revealed one conceals it again.
const spoilerClickHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = (event.target as HTMLElement).closest('.cm-live-spoiler');
    if (!target) return false;
    const revealed = target.classList.contains('cm-spoiler-revealed');
    if (revealed && !(event.metaKey || event.ctrlKey)) return false;
    const pos = view.posAtDOM(target);
    let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos + 1, 1);
    while (node && node.name !== 'Spoiler') node = node.parent;
    if (!node) return false;
    // revealed only because the cursor is inside: toggling the state field
    // would pin it open instead of concealing — let the cursor leaving hide it
    if (revealed && !isRevealed(view.state, node.from, node.to)) return false;
    view.dispatch({ effects: toggleSpoiler.of({ from: node.from, to: node.to }) });
    return true;
  },
});

// With closing markers concealed, "after the word" and "before the closing
// marker" look identical, so typed whitespace can land inside the span —
// which always breaks the emphasis syntax (a space can't precede a closing
// delimiter) and dumps raw markers back on screen. Whitespace there is never
// intended: relocate it to after the marker(s). Letters still go inside,
// extending the formatted text.
// Includes ColorSpan/Underline even though a space before their closing tag
// is syntactically harmless: a trailing space means "continue outside" there
// just the same.
const BREAKOUT_CONTAINERS = new Set([
  'StrongEmphasis',
  'Emphasis',
  'Strikethrough',
  'Highlight',
  'Spoiler',
  'ColorSpan',
  'Underline',
]);

const whitespaceBreakout = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.isUserEvent('input.type')) return tr;
  let pos: number | null = null;
  let text = '';
  let changeCount = 0;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    changeCount++;
    if (fromA === toA) {
      pos = fromA;
      text = inserted.toString();
    }
  });
  if (changeCount !== 1 || pos === null || !/^[ \t]+$/.test(text)) return tr;

  const tree = syntaxTree(tr.startState);
  let p: number = pos;
  for (;;) {
    let moved = false;
    for (
      let c: SyntaxNode | null = tree.resolveInner(p, -1);
      c;
      c = c.parent
    ) {
      if (!BREAKOUT_CONTAINERS.has(c.name)) continue;
      let lastMark: SyntaxNode | null = null;
      for (let ch = c.firstChild; ch; ch = ch.nextSibling) {
        if (/(Mark|Tag)$/.test(ch.name)) lastMark = ch;
      }
      if (lastMark && lastMark.from === p && lastMark.to === c.to) {
        p = c.to;
        moved = true;
        break;
      }
    }
    if (!moved) break;
  }
  if (p === pos) return tr;
  return {
    changes: { from: p, insert: text },
    selection: { anchor: p + text.length },
    userEvent: 'input.type',
  };
});

// Enter inside formatted inline text must not strand markers across lines
// (inline spans/emphasis can't cross paragraphs — the markup un-renders).
// Caret right before concealed closing markers: the newline relocates past
// them. Right after opening markers: it moves before them. Mid-content: the
// run splits into two valid runs (close everything, newline, reopen).
const newlineBreakout = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.isUserEvent('input')) return tr;
  let pos: number | null = null;
  let inserted = '';
  let changeCount = 0;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, ins) => {
    changeCount++;
    if (fromA === toA) {
      pos = fromA;
      inserted = ins.toString();
    }
  });
  if (changeCount !== 1 || pos === null || !/^\n[ \t]*$/.test(inserted)) return tr;

  const doc = tr.startState.doc;
  const containers: { open: SyntaxNode; close: SyntaxNode }[] = [];
  for (
    let c: SyntaxNode | null = syntaxTree(tr.startState).resolveInner(pos, -1);
    c;
    c = c.parent
  ) {
    if (!BREAKOUT_CONTAINERS.has(c.name)) continue;
    let open: SyntaxNode | null = null;
    let close: SyntaxNode | null = null;
    for (let ch = c.firstChild; ch; ch = ch.nextSibling) {
      if (/(Mark|Tag)$/.test(ch.name)) {
        if (!open) open = ch;
        close = ch;
      }
    }
    if (open && close && open !== close) containers.push({ open, close });
  }
  if (!containers.length) return tr;

  let p: number = pos;
  let i = 0;
  // caret sits right before closing markers: step past them
  while (i < containers.length && containers[i]!.close.from === p) p = containers[i++]!.close.to;
  // caret sits right after opening markers: step before them
  while (i < containers.length && containers[i]!.open.to === p) p = containers[i++]!.open.from;
  const split = containers.slice(i);

  if (p === pos && !split.length) return tr;
  const closes = split.map((c) => doc.sliceString(c.close.from, c.close.to)).join('');
  const opens = split
    .map((c) => doc.sliceString(c.open.from, c.open.to))
    .reverse()
    .join('');
  const insert = closes + inserted + opens;
  return {
    changes: { from: p, insert },
    selection: { anchor: p + insert.length },
    userEvent: 'input.type',
    scrollIntoView: true,
  };
});

export function livePreview(): Extension {
  return [revealedSpoilers, livePreviewPlugin, spoilerClickHandler, whitespaceBreakout, newlineBreakout, concealedMotion];
}
