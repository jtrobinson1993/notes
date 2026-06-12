import { syntaxTree } from '@codemirror/language';
import { RangeSet, StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { colorFromOpenTag } from './syntax';
import { attachmentResolver, EmbedWidget, ImageWidget, parseVideoUrl } from './media';

// Obsidian-style live preview: formatting markers are hidden via replace
// decorations and content is styled via mark decorations; the raw syntax
// reveals itself whenever the selection touches the node.

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
    const el = document.createElement('span');
    el.className = 'cm-live-bullet';
    el.textContent = '•';
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

// Marker node -> container whose selection state controls reveal.
const MARK_PARENTS: Record<string, true> = {
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

function lineTouched(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  return selTouches(state, line.from, line.to);
}

function buildDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const state = view.state;
  const resolver = state.facet(attachmentResolver);

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
          if (!lineTouched(state, node.from)) {
            // hide "# " including the following space
            const end = Math.min(node.to + 1, state.doc.lineAt(node.from).to);
            ranges.push(hide.range(node.from, end));
          }
          return;
        }

        if (name in MARK_PARENTS) {
          const parent = node.node.parent;
          if (parent && !selTouches(state, parent.from, parent.to)) ranges.push(hide.range(node.from, node.to));
          return;
        }

        if (name in inlineMarks) {
          ranges.push(inlineMarks[name]!.range(node.from, node.to));
          return;
        }

        if (name === 'Spoiler') {
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
          const parent = node.node.parent;
          if (parent?.name === 'Link' && !selTouches(state, parent.from, parent.to))
            ranges.push(hide.range(node.from, node.to));
          return;
        }

        if (name === 'Image') {
          if (selTouches(state, node.from, node.to)) return;
          const text = state.doc.sliceString(node.from, node.to);
          const m = /^!\[([^\]]*)\]\(([^)\s]+)[^)]*\)$/.exec(text);
          if (!m) return;
          const spoiler = hasAncestor(node.node, 'Spoiler');
          ranges.push(
            Decoration.replace({ widget: new ImageWidget(m[2]!, m[1] ?? '', spoiler, resolver) }).range(node.from, node.to),
          );
          return false;
        }

        if (name === 'Autolink') {
          if (selTouches(state, node.from, node.to)) return;
          const url = state.doc.sliceString(node.from, node.to).replace(/^<|>$/g, '');
          const embed = parseVideoUrl(url);
          if (embed) {
            ranges.push(Decoration.replace({ widget: new EmbedWidget(embed), block: false }).range(node.from, node.to));
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
          if (!lineTouched(state, node.from)) {
            const end = state.doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
            ranges.push(hide.range(node.from, end));
          }
          return;
        }

        if (name === 'ListMark') {
          const text = state.doc.sliceString(node.from, node.to);
          if (/^[-*+]$/.test(text) && !lineTouched(state, node.from) && node.node.parent?.parent?.name !== 'Task')
            ranges.push(Decoration.replace({ widget: bulletWidget }).range(node.from, node.to));
          return;
        }

        if (name === 'HorizontalRule') {
          if (!lineTouched(state, node.from))
            ranges.push(Decoration.replace({ widget: hrWidget }).range(node.from, node.to));
          return;
        }

        return;
      },
    });
  }

  return RangeSet.of(
    ranges.sort((a, b) => a.from - b.from || a.to - b.to),
    false,
  );
}

function hasAncestor(node: SyntaxNode, name: string): boolean {
  for (let p = node.parent; p; p = p.parent) if (p.name === name) return true;
  return false;
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.transactions.some((tr) => tr.effects.some((e) => e.is(toggleSpoiler))) ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      )
        this.decorations = buildDecorations(update.view);
    }
  },
  { decorations: (v) => v.decorations },
);

// Clicking a concealed spoiler reveals it instead of placing the cursor.
const spoilerClickHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = (event.target as HTMLElement).closest('.cm-live-spoiler');
    if (!target || target.classList.contains('cm-spoiler-revealed')) return false;
    const pos = view.posAtDOM(target);
    let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos + 1, 1);
    while (node && node.name !== 'Spoiler') node = node.parent;
    if (!node) return false;
    view.dispatch({ effects: toggleSpoiler.of({ from: node.from, to: node.to }) });
    return true;
  },
});

export function livePreview(): Extension {
  return [revealedSpoilers, livePreviewPlugin, spoilerClickHandler];
}
