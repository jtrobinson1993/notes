import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';

// Detects an active `:shortcode` autocomplete trigger at the caret. The colon
// must start a line or follow whitespace (so mid-word `http://` etc. never
// triggers), and at least two name characters must follow (matches the
// shortcode minimum and keeps a bare `:` from popping the menu).

export interface EmojiTrigger {
  /** Offset of the `:` that opened the trigger. */
  from: number;
  /** The text typed after the colon (the search query). */
  query: string;
}

const TRIGGER_RE = /(?:^|\s):([A-Za-z0-9_+-]{2,})$/;

export function detectEmojiTrigger(state: EditorState): EmojiTrigger | null {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const pos = sel.head;
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  const m = TRIGGER_RE.exec(before);
  if (!m) return null;
  const query = m[1]!;
  const from = pos - query.length - 1; // the ':' just before the query

  // Never inside code — a `:shortcode:` there is meant literally.
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(from, 1); n; n = n.parent) {
    if (n.name === 'InlineCode' || n.name === 'FencedCode' || n.name === 'CodeBlock') return null;
  }
  return { from, query };
}
