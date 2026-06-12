import { syntaxTree } from '@codemirror/language';
import { RangeSet, type Extension, type Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';

// Chrome for ``` fenced code blocks: a header bar with a language picker and
// copy button, code-block line styling, and fence-marker concealment when the
// cursor is outside the block. Per-language syntax highlighting itself comes
// from markdown({ codeLanguages: languages }).

const PICKER_LANGS = [
  '',
  'typescript',
  'javascript',
  'python',
  'bash',
  'sql',
  'json',
  'yaml',
  'html',
  'css',
  'rust',
  'go',
  'c',
  'cpp',
  'java',
  'markdown',
];

class CodeChromeWidget extends WidgetType {
  constructor(readonly lang: string) {
    super();
  }

  override eq(other: CodeChromeWidget): boolean {
    return other.lang === this.lang;
  }

  toDOM(view: EditorView): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'cm-codeblock-chrome';

    const select = document.createElement('select');
    select.className = 'cm-codeblock-lang';
    const langs = PICKER_LANGS.includes(this.lang) ? PICKER_LANGS : [this.lang, ...PICKER_LANGS];
    for (const lang of langs) {
      const opt = document.createElement('option');
      opt.value = lang;
      opt.textContent = lang || 'plain';
      opt.selected = lang === this.lang;
      select.append(opt);
    }
    select.addEventListener('change', () => {
      const block = blockAt(view, view.posAtDOM(bar));
      if (!block) return;
      const info = block.getChild('CodeInfo');
      const openMark = block.getChild('CodeMark');
      if (info) {
        view.dispatch({ changes: { from: info.from, to: info.to, insert: select.value } });
      } else if (openMark) {
        view.dispatch({ changes: { from: openMark.to, insert: select.value } });
      }
    });

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'cm-codeblock-copy';
    copy.textContent = 'Copy';
    copy.addEventListener('click', () => {
      const block = blockAt(view, view.posAtDOM(bar));
      const text = block?.getChild('CodeText');
      if (!text) return;
      void navigator.clipboard.writeText(view.state.sliceDoc(text.from, text.to)).then(() => {
        copy.textContent = 'Copied!';
        setTimeout(() => (copy.textContent = 'Copy'), 1500);
      });
    });

    bar.append(select, copy);
    return bar;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function blockAt(view: EditorView, pos: number): SyntaxNode | null {
  let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, 1);
  while (node && node.name !== 'FencedCode') node = node.parent;
  return node;
}

const codeLine = Decoration.line({ class: 'cm-live-codeblock' });
const codeLineFirst = Decoration.line({ class: 'cm-live-codeblock cm-live-codeblock-first' });
const codeLineLast = Decoration.line({ class: 'cm-live-codeblock cm-live-codeblock-last' });
const hide = Decoration.replace({});

function buildDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const state = view.state;

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (node.name !== 'FencedCode') return;
        const block = node.node;
        const touched = state.selection.ranges.some((r) => r.from <= block.to && r.to >= block.from);
        const firstLine = state.doc.lineAt(block.from);
        const lastLine = state.doc.lineAt(block.to);

        const info = block.getChild('CodeInfo');
        const lang = info ? state.sliceDoc(info.from, info.to) : '';
        ranges.push(
          Decoration.widget({ widget: new CodeChromeWidget(lang), block: true, side: -10 }).range(firstLine.from),
        );

        for (let l = firstLine.number; l <= lastLine.number; l++) {
          const line = state.doc.line(l);
          const deco = l === firstLine.number ? codeLineFirst : l === lastLine.number ? codeLineLast : codeLine;
          ranges.push(deco.range(line.from));
        }

        if (!touched) {
          // conceal ```lang and the closing ```
          const openEnd = info ? info.to : (block.getChild('CodeMark')?.to ?? firstLine.to);
          ranges.push(hide.range(firstLine.from, Math.min(openEnd, firstLine.to)));
          const closeMarks = block.getChildren('CodeMark');
          const closing = closeMarks[closeMarks.length - 1];
          if (closeMarks.length > 1 && closing) ranges.push(hide.range(closing.from, closing.to));
        }
        return false;
      },
    });
  }

  return RangeSet.of(
    ranges.sort((a, b) => a.from - b.from || a.to - b.to),
    false,
  );
}

const codeBlocksPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged)
        this.decorations = buildDecorations(update.view);
    }
  },
  { decorations: (v) => v.decorations },
);

export function codeBlocks(): Extension {
  return [codeBlocksPlugin];
}
