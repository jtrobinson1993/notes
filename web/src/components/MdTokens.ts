import { defineComponent, h, ref, type PropType, type VNodeChild } from 'vue';
import { marked, type Token, type Tokens } from 'marked';
import { embedSrc, parseVideoUrl, VIMEO_LOGO, YT_LOGO, type VideoEmbed } from '../lib/editor/media';
import { COLOR_VALUE_RE } from '../lib/editor/syntax';
import { clickToLoadEmbeds, clickToLoadImages } from '../lib/privacy';

// Markdown rendering from marked's token stream straight to VNodes: no HTML
// string is ever parsed, so there is nothing for a sanitizer to miss. Raw
// HTML in the source renders as literal text, except the two inline pairs our
// editor writes (<u>…</u> and <span style="color:…">…</span> with validated
// color values), which are built as real elements.

export type AttachmentResolver = (id: string) => Promise<string | null>;

const SAFE_HREF = /^(https?:|mailto:|tel:)/i;
const OPEN_SPAN_RE = /^<span style="color:([^"<>]{1,80})">$/;

// decode HTML entities in token text (marked leaves them encoded); textarea
// content is RCDATA, so this never constructs elements
const decoder = document.createElement('textarea');
function decode(text: string): string {
  decoder.innerHTML = text;
  return decoder.value;
}

const RemoteImage = defineComponent({
  props: { src: { type: String, required: true }, alt: { type: String, default: '' } },
  setup(props) {
    const loaded = ref(!clickToLoadImages.value);
    let host = '';
    try {
      host = new URL(props.src).hostname;
    } catch {
      /* generic label */
    }
    return () =>
      loaded.value
        ? h('img', { src: props.src, alt: props.alt })
        : h(
            'button',
            {
              type: 'button',
              class: 'image-placeholder-btn',
              onClick: (e: Event) => {
                e.preventDefault();
                loaded.value = true;
              },
            },
            `🖼 Load image${host ? ` from ${host}` : ''}`,
          );
  },
});

const AttachmentImage = defineComponent({
  props: {
    id: { type: String, required: true },
    alt: { type: String, default: '' },
    resolve: { type: Function as PropType<AttachmentResolver>, required: true },
  },
  setup(props) {
    const src = ref<string | null>(null);
    const missing = ref(false);
    void props.resolve(props.id).then((url) => {
      if (url) src.value = url;
      else missing.value = true;
    });
    return () =>
      src.value
        ? h('img', { src: src.value, alt: props.alt })
        : h('span', { class: 'text-sm text-zinc-400' }, missing.value ? `[missing attachment ${props.alt}]` : props.alt);
  },
});

const EmbedFrame = defineComponent({
  props: { embed: { type: Object as PropType<VideoEmbed>, required: true } },
  setup(props) {
    const loaded = ref(!clickToLoadEmbeds.value);
    const label = props.embed.platform === 'youtube' ? 'YouTube' : 'Vimeo';
    return () =>
      h('div', { class: loaded.value ? 'embed-placeholder embed-loaded' : 'embed-placeholder' }, [
        loaded.value
          ? h('iframe', {
              src: embedSrc(props.embed),
              class: 'embed-iframe',
              allow: 'accelerometer; encrypted-media; fullscreen; picture-in-picture',
              allowfullscreen: true,
            })
          : h('button', {
              type: 'button',
              class: 'embed-placeholder-btn',
              // constant markup (platform logos), no user content
              innerHTML: `${props.embed.platform === 'youtube' ? YT_LOGO : VIMEO_LOGO}<span>Load ${label} video</span>`,
              onClick: (e: Event) => {
                e.preventDefault();
                loaded.value = true;
              },
            }),
      ]);
  },
});

function renderBlocks(tokens: Token[], resolve: AttachmentResolver): VNodeChild[] {
  return tokens.map((t) => renderToken(t, resolve));
}

// Inline tokens, pairing the raw-HTML <u>/<span color> tags our editor
// writes; any other raw HTML becomes visible literal text.
function renderInline(tokens: Token[] | undefined, resolve: AttachmentResolver): VNodeChild[] {
  if (!tokens) return [];
  const out: VNodeChild[] = [];
  const stack: { tag: 'u' | 'span'; style?: string; children: VNodeChild[] }[] = [];
  const sink = () => (stack.length ? stack[stack.length - 1]!.children : out);
  for (const t of tokens) {
    if (t.type === 'html') {
      const text = (t as Tokens.HTML).text.trim();
      if (text === '<u>') {
        stack.push({ tag: 'u', children: [] });
        continue;
      }
      const m = OPEN_SPAN_RE.exec(text);
      if (m && COLOR_VALUE_RE.test(m[1]!.trim())) {
        stack.push({ tag: 'span', style: `color:${m[1]!.trim()}`, children: [] });
        continue;
      }
      if ((text === '</u>' || text === '</span>') && stack.length) {
        const f = stack.pop()!;
        sink().push(h(f.tag, f.style ? { style: f.style } : {}, f.children));
        continue;
      }
      sink().push(decode((t as Tokens.HTML).text));
      continue;
    }
    sink().push(renderToken(t, resolve));
  }
  // unclosed tags: flatten children without the wrapper
  while (stack.length) {
    const f = stack.pop()!;
    sink().push(...f.children);
  }
  return out;
}

function renderToken(t: Token, resolve: AttachmentResolver): VNodeChild {
  switch (t.type) {
    case 'space':
      return null;
    case 'paragraph':
      return h('p', renderInline((t as Tokens.Paragraph).tokens, resolve));
    case 'heading':
      return h(`h${(t as Tokens.Heading).depth}`, renderInline((t as Tokens.Heading).tokens, resolve));
    case 'code': {
      const c = t as Tokens.Code;
      return h('pre', h('code', c.lang ? { class: `language-${c.lang}` } : {}, c.text));
    }
    case 'blockquote':
      return h('blockquote', renderBlocks((t as Tokens.Blockquote).tokens, resolve));
    case 'list': {
      const l = t as Tokens.List;
      const attrs = l.ordered && l.start !== '' && l.start !== 1 ? { start: l.start } : {};
      return h(
        l.ordered ? 'ol' : 'ul',
        attrs,
        l.items.map((item) =>
          h(
            'li',
            item.task
              ? [
                  h('input', { type: 'checkbox', checked: item.checked ?? false, disabled: true, class: 'mr-1.5' }),
                  ...renderBlocks(item.tokens, resolve),
                ]
              : renderBlocks(item.tokens, resolve),
          ),
        ),
      );
    }
    case 'table': {
      const tbl = t as Tokens.Table;
      const cellStyle = (i: number) => (tbl.align[i] ? { textAlign: tbl.align[i]! } : undefined);
      return h('table', [
        h('thead', h('tr', tbl.header.map((c, i) => h('th', { style: cellStyle(i) }, renderInline(c.tokens, resolve))))),
        h('tbody', tbl.rows.map((row) => h('tr', row.map((c, i) => h('td', { style: cellStyle(i) }, renderInline(c.tokens, resolve)))))),
      ]);
    }
    case 'hr':
      return h('hr');
    case 'html':
      // block-level raw HTML (e.g. a line starting with <u>): re-lex as
      // inline content so our recognized pairs still work; everything else
      // in it renders as literal text
      return h('p', renderInline(marked.Lexer.lexInline((t as Tokens.HTML).text.trim(), marked.defaults), resolve));
    case 'text': {
      const tt = t as Tokens.Text;
      return tt.tokens ? renderInline(tt.tokens, resolve) : decode(tt.text);
    }
    case 'escape':
      return decode((t as Tokens.Escape).text);
    case 'strong':
      return h('strong', renderInline((t as Tokens.Strong).tokens, resolve));
    case 'em':
      return h('em', renderInline((t as Tokens.Em).tokens, resolve));
    case 'del':
      return h('del', renderInline((t as Tokens.Del).tokens, resolve));
    case 'codespan':
      return h('code', decode((t as Tokens.Codespan).text));
    case 'br':
      return h('br');
    case 'link': {
      const l = t as Tokens.Link;
      const embed = l.text === l.href ? parseVideoUrl(l.href) : null;
      if (embed) return h(EmbedFrame, { embed });
      if (!SAFE_HREF.test(l.href)) return renderInline(l.tokens, resolve);
      return h('a', { href: l.href }, renderInline(l.tokens, resolve));
    }
    case 'image': {
      const im = t as Tokens.Image;
      if (im.href.startsWith('attachment:')) {
        return h(AttachmentImage, { id: im.href.slice('attachment:'.length), alt: im.text, resolve });
      }
      if (/^https?:/i.test(im.href)) return h(RemoteImage, { src: im.href, alt: im.text });
      return im.text;
    }
    case 'highlight':
      return h('mark', renderInline((t as Tokens.Generic).tokens as Token[], resolve));
    case 'spoiler':
      return h('span', { class: 'spoiler' }, renderInline((t as Tokens.Generic).tokens as Token[], resolve));
    default:
      return decode((t as { raw?: string }).raw ?? '');
  }
}

export default defineComponent({
  name: 'MdTokens',
  props: {
    tokens: { type: Array as PropType<Token[]>, required: true },
    resolve: { type: Function as PropType<AttachmentResolver>, required: true },
  },
  setup(props) {
    return () => renderBlocks(props.tokens, props.resolve);
  },
});
