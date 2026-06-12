import type { DelimiterType, InlineContext, MarkdownConfig } from '@lezer/markdown';
import { tags as t } from '@lezer/highlight';

// Extended inline syntax for the live editor:
//   ==highlight==   ||spoiler||   <u>underline</u>   <span style="color:…">…</span>
// Each becomes a container node wrapping *Mark nodes, mirroring how the GFM
// Strikethrough extension is built, so the live-preview plugin can conceal
// the markers and style the content.

const Punctuation = /[!-/:-@[-`{-~¡‐-‧]/;

function delimiterParser(name: string, ch: number) {
  const delim: DelimiterType = { resolve: name, mark: `${name}Mark` };
  return (cx: InlineContext, next: number, pos: number): number => {
    if (next !== ch || cx.char(pos + 1) !== ch || cx.char(pos + 2) === ch) return -1;
    const before = cx.slice(pos - 1, pos);
    const after = cx.slice(pos + 2, pos + 3);
    const sBefore = /\s|^$/.test(before);
    const sAfter = /\s|^$/.test(after);
    const pBefore = Punctuation.test(before);
    const pAfter = Punctuation.test(after);
    return cx.addDelimiter(
      delim,
      pos,
      pos + 2,
      !sAfter && (!pAfter || sBefore || pBefore),
      !sBefore && (!pBefore || sAfter || pAfter),
    );
  };
}

export const Highlight: MarkdownConfig = {
  defineNodes: [
    { name: 'Highlight', style: { 'Highlight/...': t.special(t.emphasis) } },
    { name: 'HighlightMark', style: t.processingInstruction },
  ],
  parseInline: [{ name: 'Highlight', parse: delimiterParser('Highlight', 61 /* = */), after: 'Emphasis' }],
};

export const Spoiler: MarkdownConfig = {
  defineNodes: [
    { name: 'Spoiler', style: { 'Spoiler/...': t.special(t.content) } },
    { name: 'SpoilerMark', style: t.processingInstruction },
  ],
  parseInline: [{ name: 'Spoiler', parse: delimiterParser('Spoiler', 124 /* | */), after: 'Emphasis' }],
};

// <u>…</u> and <span style="color:…">…</span> as paired delimiters, parsed
// ahead of the generic HTMLTag parser so they get real container nodes.
const UnderlineDelim: DelimiterType = { resolve: 'Underline', mark: 'UnderlineTag' };
const ColorSpanDelim: DelimiterType = { resolve: 'ColorSpan', mark: 'ColorSpanTag' };

// Only color values we ever write: a brand var or an inline light-dark pair.
export const COLOR_VALUE_RE =
  /^(var\(--brand-[a-z]+\)|light-dark\(#[0-9a-fA-F]{3,8}, ?#[0-9a-fA-F]{3,8}\))$/;

const OPEN_SPAN_RE = /^<span style="color:([^"<>]{1,80})">/;

export const InlineHtmlPairs: MarkdownConfig = {
  defineNodes: [
    { name: 'Underline', style: { 'Underline/...': t.special(t.emphasis) } },
    { name: 'UnderlineTag', style: t.processingInstruction },
    { name: 'ColorSpan' },
    { name: 'ColorSpanTag', style: t.processingInstruction },
  ],
  parseInline: [
    {
      name: 'InlineHtmlPairs',
      before: 'HTMLTag',
      parse(cx, next, pos) {
        if (next !== 60 /* < */) return -1;
        const rest = cx.slice(pos, Math.min(cx.end, pos + 100));
        if (rest.startsWith('<u>')) return cx.addDelimiter(UnderlineDelim, pos, pos + 3, true, false);
        if (rest.startsWith('</u>')) return cx.addDelimiter(UnderlineDelim, pos, pos + 4, false, true);
        const m = OPEN_SPAN_RE.exec(rest);
        if (m && COLOR_VALUE_RE.test(m[1]!.trim()))
          return cx.addDelimiter(ColorSpanDelim, pos, pos + m[0].length, true, false);
        if (rest.startsWith('</span>')) return cx.addDelimiter(ColorSpanDelim, pos, pos + 7, false, true);
        return -1;
      },
    },
  ],
};

export const extendedSyntax: MarkdownConfig[] = [Highlight, Spoiler, InlineHtmlPairs];

// Extract the CSS color value from a ColorSpan's opening tag text.
export function colorFromOpenTag(text: string): string | null {
  const m = /color:([^"<>]{1,80})"/.exec(text);
  const v = m?.[1]?.trim() ?? '';
  return COLOR_VALUE_RE.test(v) ? v : null;
}
