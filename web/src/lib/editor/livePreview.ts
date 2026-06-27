import { cursorCharLeft, cursorCharRight, selectCharLeft, selectCharRight } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState, Prec, RangeSet, StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
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

// Clickable task-list checkbox replacing a `[ ]` / `[x]` TaskMarker in live
// preview. `pos` is the offset of the inner state char (TaskMarker.from + 1);
// toggling dispatches a single-char replace flipping ' '<->'x'.
class TaskCheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number,
  ) {
    super();
  }
  override eq(other: TaskCheckboxWidget): boolean {
    return other.checked === this.checked && other.pos === this.pos;
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.checked;
    box.className = 'cm-task-checkbox mr-1 cursor-pointer align-middle accent-blue-600';
    box.addEventListener('mousedown', (e) => {
      // let the checkbox own the click; CM must not move the caret into the
      // concealed marker (the range is atomic anyway)
      e.preventDefault();
      e.stopPropagation();
      view.dispatch({
        changes: { from: this.pos, to: this.pos + 1, insert: this.checked ? ' ' : 'x' },
      });
      view.focus();
    });
    return box;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

// ---- editable table ------------------------------------------------------

// A single editable cell with its absolute source range and current text.
interface TableCellModel {
  from: number;
  to: number;
  text: string;
}
type TableAlign = 'left' | 'center' | 'right' | null;
interface TableModel {
  header: TableCellModel[];
  rows: TableCellModel[][];
  align: TableAlign[];
}

// Parse a GFM table from its raw source (and absolute start offset) into a
// grid of cells, each carrying the exact source range of its inner text so a
// single-cell edit rewrites only that slice. We parse the pipes ourselves
// rather than leaning on the sparse TableCell nodes so empty cells still get a
// well-defined insertion range, and the delimiter row is skipped (never
// edited). Cells are the text *between* pipes, trimmed; the stored range spans
// the trimmed text (or the gap between surrounding spaces when empty).
function parseTable(raw: string, base: number): TableModel | null {
  const lines = raw.split('\n');
  if (lines.length < 2) return null;

  // split one table line into cell ranges (absolute), honouring a leading and
  // trailing pipe but tolerating their absence; escaped \| stays in-cell
  const splitRow = (line: string, lineStart: number): TableCellModel[] => {
    const cells: TableCellModel[] = [];
    let cellStart = 0;
    let i = 0;
    // skip a leading pipe
    if (line[0] === '|') {
      i = 1;
      cellStart = 1;
    }
    const pushCell = (segStart: number, segEnd: number) => {
      const seg = line.slice(segStart, segEnd);
      const lead = seg.length - seg.trimStart().length;
      const trimmed = seg.trim();
      const from = lineStart + segStart + lead;
      cells.push({ from, to: from + trimmed.length, text: trimmed });
    };
    for (; i < line.length; i++) {
      if (line[i] === '\\') {
        i++;
        continue;
      }
      if (line[i] === '|') {
        pushCell(cellStart, i);
        cellStart = i + 1;
      }
    }
    // trailing segment after the last pipe — drop it only if it's the empty
    // tail produced by a trailing pipe
    if (!(line[line.length - 1] === '|' && cellStart === line.length)) {
      pushCell(cellStart, line.length);
    }
    return cells;
  };

  // line offsets within raw
  const lineStarts: number[] = [];
  let acc = 0;
  for (const l of lines) {
    lineStarts.push(acc);
    acc += l.length + 1; // +1 for the consumed '\n'
  }

  const header = splitRow(lines[0]!, base + lineStarts[0]!);
  const delim = lines[1] ?? '';
  const align: TableAlign[] = splitRow(delim, base + lineStarts[1]!).map((c) => {
    const t = c.text;
    const l = t.startsWith(':');
    const r = t.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
  });
  const rows: TableCellModel[][] = [];
  for (let li = 2; li < lines.length; li++) {
    if (!lines[li]!.trim()) continue;
    rows.push(splitRow(lines[li]!, base + lineStarts[li]!));
  }
  return { header, rows, align };
}

const ALIGN_CLASS: Record<NonNullable<TableAlign>, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

// Live-preview editable table: replaces the whole table source with a real
// <table> whose cells are text inputs. Committing a cell (Enter / blur)
// rewrites just that cell's source range. eq() compares the raw source so the
// widget only rebuilds when the table text actually changes (keeps focus
// stable while typing elsewhere). The block is atomic; the caret leaves it via
// the surrounding lines.
class TableWidget extends WidgetType {
  constructor(
    readonly raw: string,
    readonly base: number,
  ) {
    super();
  }
  override eq(other: TableWidget): boolean {
    return other.raw === this.raw && other.base === this.base;
  }
  toDOM(view: EditorView): HTMLElement {
    const model = parseTable(this.raw, this.base);
    const wrap = document.createElement('div');
    wrap.className = 'cm-live-table my-1 overflow-x-auto';
    const table = document.createElement('table');
    table.className = 'border-collapse';
    if (!model) {
      wrap.append(table);
      return wrap;
    }

    const commit = (cell: TableCellModel, value: string) => {
      // a raw | or newline in a cell would break the table grammar; escape
      // pipes and collapse newlines so the edit can't corrupt the structure
      const next = value.trim().replace(/\\?\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
      if (next === cell.text) return;
      view.dispatch({ changes: { from: cell.from, to: cell.to, insert: next } });
    };

    const makeCell = (tag: 'th' | 'td', cell: TableCellModel | undefined, colAlign: TableAlign) => {
      const td = document.createElement(tag);
      const alignCls = colAlign ? ` ${ALIGN_CLASS[colAlign]}` : '';
      td.className = `border border-zinc-300 px-2 py-1 dark:border-zinc-700${alignCls}`;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = cell?.text ?? '';
      input.className = `w-full min-w-16 bg-transparent outline-none${alignCls}`;
      if (tag === 'th') input.className += ' font-semibold';
      if (cell) {
        input.addEventListener('blur', () => commit(cell, input.value));
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            input.blur();
          }
        });
      } else {
        input.disabled = true;
      }
      td.append(input);
      return td;
    };

    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    model.header.forEach((c, i) => htr.append(makeCell('th', c, model.align[i] ?? null)));
    thead.append(htr);
    table.append(thead);

    const tbody = document.createElement('tbody');
    for (const row of model.rows) {
      const tr = document.createElement('tr');
      for (let i = 0; i < model.header.length; i++) tr.append(makeCell('td', row[i], model.align[i] ?? null));
      tbody.append(tr);
    }
    table.append(tbody);
    wrap.append(table);
    return wrap;
  }
  override ignoreEvent(): boolean {
    // let the cell inputs handle their own keyboard/mouse events
    return true;
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

        if (name === 'TaskMarker') {
          // `[ ]` / `[x]` -> real checkbox; the marker chars are concealed and
          // atomic, the inner state char (from+1) is what we flip
          const marker = state.doc.sliceString(node.from, node.to);
          const checked = /x/i.test(marker);
          conceal(node.from, node.to, Decoration.replace({ widget: new TaskCheckboxWidget(checked, node.from + 1) }));
          return false;
        }

        if (name === 'ListMark') {
          const text = state.doc.sliceString(node.from, node.to);
          if (!/^[-*+]$/.test(text)) return;
          // Only style a bullet once the marker is a real "- " — a space/tab
          // must follow. A bare "-" (an empty item the user is mid-typing, which
          // CommonMark still parses as a list at the doc/section start) stays
          // literal text, so list styling appears only on hyphen + space.
          const after = state.doc.sliceString(node.to, node.to + 1);
          if (after !== ' ' && after !== '\t') return;
          // task items render a checkbox instead of a bullet dot: hide the
          // marker (and the following space) outright so we don't get both
          const item = node.node.parent;
          const isTask = item?.firstChild?.nextSibling?.name === 'Task';
          if (isTask) {
            const end = state.doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
            conceal(node.from, end);
            return;
          }
          conceal(node.from, node.to, Decoration.replace({ widget: bulletWidget }));
          return;
        }

        if (name === 'Table') {
          // tables are rendered by a separate StateField (tableField): block /
          // line-break-spanning decorations can't be provided from a ViewPlugin
          return false;
        }

        if (name === 'HorizontalRule') {
          conceal(node.from, node.to, Decoration.replace({ widget: hrWidget }));
          return;
        }

        return;
      },
    });
  }

  // List-start after a hard newline: CommonMark won't let an *empty* bullet
  // item ("- ") interrupt a paragraph, so on a freshly Shift+Enter-broken line
  // the marker stays literal until the first character is typed. Render the
  // bullet anyway so the list starts immediately, matching a fresh line. Only
  // fires when the parser hasn't already made the line a list item (a real list
  // is handled by the ListMark branch above) and we're not inside code.
  const tree = syntaxTree(state);
  for (const { from, to } of view.visibleRanges) {
    const lastLine = state.doc.lineAt(to).number;
    for (let lineNo = state.doc.lineAt(from).number; lineNo <= lastLine; lineNo++) {
      const line = state.doc.line(lineNo);
      const m = /^(\s*)[-*+]\s/.exec(line.text);
      if (!m) continue;
      const markerPos = line.from + m[1]!.length;
      let skip = false;
      for (let n: SyntaxNode | null = tree.resolveInner(markerPos, 1); n; n = n.parent) {
        if (n.name === 'ListItem' || n.name === 'BulletList' || n.name === 'FencedCode' || n.name === 'CodeBlock') {
          skip = true;
          break;
        }
      }
      if (!skip) conceal(markerPos, markerPos + 1, Decoration.replace({ widget: bulletWidget }));
    }
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

// ---- editable tables (StateField) ----------------------------------------
// Block widgets and replacements that span line breaks can't be provided by a
// ViewPlugin (CM throws), so tables live in their own StateField. It rebuilds
// only when the syntax tree changes — the table widget's eq() keeps focus
// stable across unrelated edits.

interface TableDecos {
  decorations: DecorationSet;
  atomics: RangeSet<Decoration>;
}

function buildTableDecorations(state: EditorState): TableDecos {
  const decos: Range<Decoration>[] = [];
  const atomics: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'Table') return undefined;
      const raw = state.doc.sliceString(node.from, node.to);
      decos.push(
        Decoration.replace({ widget: new TableWidget(raw, node.from), block: true }).range(node.from, node.to),
      );
      atomics.push(hide.range(node.from, node.to));
      return false;
    },
  });
  return { decorations: RangeSet.of(decos, false), atomics: RangeSet.of(atomics, false) };
}

const tableField = StateField.define<TableDecos>({
  create: (state) => buildTableDecorations(state),
  update(value, tr) {
    if (syntaxTree(tr.startState) !== syntaxTree(tr.state) || tr.docChanged)
      return buildTableDecorations(tr.state);
    return value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (v) => v.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).atomics),
  ],
});

// Concealed markers are atomic, but the positions on either side of one
// render at the same visual spot — a plain arrow step across a marker looks
// like the caret didn't move (one "dead" press at every span edge). Repeat
// the motion until the caret moves somewhere visible.

function coveredByConcealed(view: EditorView, a: number, b: number): boolean {
  if (a === b) return false;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  // consult both the inline-marker atomics (plugin) and the table atomics
  // (field) so arrow motion steps cleanly past a whole table block too
  const sets = [view.plugin(livePreviewPlugin)?.atomics, view.state.field(tableField, false)?.atomics].filter(
    (s): s is RangeSet<Decoration> => !!s,
  );
  if (!sets.length) return false;
  let pos = lo;
  for (let guard = 0; guard < 64; guard++) {
    let advanced = false;
    for (const set of sets) {
      const iter = set.iter(pos);
      while (iter.value && iter.from <= pos) {
        if (iter.to > pos) {
          pos = iter.to;
          advanced = true;
        }
        iter.next();
      }
    }
    if (!advanced) break;
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

// Backspacing at the trailing edge of a formatted span (e.g. `<span…>…</span>`)
// must not chew the concealed, atomic markers — which CodeMirror's default
// backspace deletes whole, stripping the formatting and dumping raw markup. When
// there's >1 content char, delete the last *letter* (keep the formatting); when
// the last char would empty the span, delete the **whole construct** (both
// markers go with it, so nothing is left orphaned).
const smartBackspace: Command = (view) => {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const pos = sel.head;
  for (let c: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, -1); c; c = c.parent) {
    if (!BREAKOUT_CONTAINERS.has(c.name)) continue;
    let open: SyntaxNode | null = null;
    let close: SyntaxNode | null = null;
    for (let ch = c.firstChild; ch; ch = ch.nextSibling) {
      if (/(Mark|Tag)$/.test(ch.name)) {
        if (!open) open = ch;
        close = ch;
      }
    }
    if (!open || !close || open === close) continue;
    const contentLen = close.from - open.to;
    // Only act at the span's trailing edge: after the close marker, just before
    // it (visual end of content), or — when empty — the slot between the markers.
    const trailing = pos === c.to || pos === close.from || (contentLen === 0 && pos === open.to);
    if (!trailing) continue;
    if (contentLen <= 1) {
      // The (0- or 1-char) content empties the span → remove markers + content.
      view.dispatch({
        changes: { from: c.from, to: c.to },
        selection: EditorSelection.cursor(c.from),
        userEvent: 'delete.backward',
        scrollIntoView: true,
      });
      return true;
    }
    const delFrom = close.from - 1;
    if (coveredByConcealed(view, delFrom, close.from)) return false; // nested marker — leave it
    view.dispatch({
      changes: { from: delFrom, to: close.from },
      selection: EditorSelection.cursor(delFrom),
      userEvent: 'delete.backward',
      scrollIntoView: true,
    });
    return true;
  }
  return false;
};

const concealedBackspace = Prec.high(keymap.of([{ key: 'Backspace', run: smartBackspace }]));

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
  return [
    revealedSpoilers,
    livePreviewPlugin,
    tableField,
    spoilerClickHandler,
    whitespaceBreakout,
    newlineBreakout,
    concealedMotion,
    concealedBackspace,
  ];
}
