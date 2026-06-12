<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watchEffect } from 'vue';
import { marked, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import type { AttachmentRef } from '@notes/shared';
import { api } from '../lib/api';
import { decryptBlob } from '../lib/crypto';
import { buildEmbedPlaceholder, parseVideoUrl } from '../lib/editor/media';

const props = defineProps<{ source: string; attachments?: AttachmentRef[] }>();

// allow the attachment: scheme used for encrypted embedded images
const URI_RE = /^(?:(?:https?|mailto|tel|attachment):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

// Extended syntax shared with the live editor: ==highlight== and ||spoiler||.
interface InlineToken extends Tokens.Generic {
  tokens: Tokens.Generic[];
}

marked.use({
  extensions: [
    {
      name: 'highlight',
      level: 'inline',
      start: (src: string) => src.indexOf('=='),
      tokenizer(src: string): InlineToken | undefined {
        const m = /^==([^=\n]+(?:=[^=\n]+)*)==/.exec(src);
        if (!m) return undefined;
        return { type: 'highlight', raw: m[0], tokens: this.lexer.inlineTokens(m[1]!) };
      },
      renderer(token) {
        return `<mark>${this.parser.parseInline((token as InlineToken).tokens)}</mark>`;
      },
    },
    {
      name: 'spoiler',
      level: 'inline',
      start: (src: string) => src.indexOf('||'),
      tokenizer(src: string): InlineToken | undefined {
        const m = /^\|\|([^|\n]+(?:\|[^|\n]+)*)\|\|/.exec(src);
        if (!m) return undefined;
        return { type: 'spoiler', raw: m[0], tokens: this.lexer.inlineTokens(m[1]!) };
      },
      renderer(token) {
        return `<span class="spoiler">${this.parser.parseInline((token as InlineToken).tokens)}</span>`;
      },
    },
  ],
});

const html = computed(() =>
  DOMPurify.sanitize(marked.parse(props.source, { async: false }), { ALLOWED_URI_REGEXP: URI_RE }),
);

const root = ref<HTMLDivElement>();
const objectUrls: string[] = [];

// click-to-reveal spoilers (delegated; spoilers re-render with the note)
function onClick(event: MouseEvent) {
  const spoiler = (event.target as HTMLElement).closest('.spoiler');
  if (spoiler && root.value?.contains(spoiler) && !spoiler.classList.contains('spoiler-revealed')) {
    spoiler.classList.add('spoiler-revealed');
    event.preventDefault();
  }
}

// Post-render: resolve encrypted attachment images and swap YouTube/Vimeo
// autolinks for click-to-load placeholders (no third-party request until
// the reader clicks).
watchEffect(async () => {
  void html.value;
  const el = root.value;
  if (!el) return;
  await new Promise((r) => requestAnimationFrame(r));

  for (const a of el.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const embed = parseVideoUrl(a.href);
    if (embed && a.textContent?.trim() === a.href) a.replaceWith(buildEmbedPlaceholder(embed));
  }

  for (const img of el.querySelectorAll<HTMLImageElement>('img[src^="attachment:"]')) {
    const id = img.getAttribute('src')!.slice('attachment:'.length);
    const ref = props.attachments?.find((a) => a.id === id);
    if (!ref) continue;
    try {
      const ct = await api.attachmentDownload(ref.id);
      const data = await decryptBlob(ct, ref.key, ref.iv);
      const url = URL.createObjectURL(new Blob([data as BlobPart], { type: ref.type }));
      objectUrls.push(url);
      img.src = url;
    } catch {
      img.alt = `[failed to load ${ref.name}]`;
    }
  }
});

onBeforeUnmount(() => {
  for (const url of objectUrls) URL.revokeObjectURL(url);
});
</script>

<template>
  <div ref="root" class="md-preview" @click="onClick" v-html="html" />
</template>
