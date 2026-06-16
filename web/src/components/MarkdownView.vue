<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { marked, type Tokens } from 'marked';
import type { AttachmentRef } from '@notes/shared';
import { api } from '../lib/api';
import { decryptBlob } from '../lib/crypto';
import MdTokens from './MdTokens';

const props = defineProps<{ source: string; attachments?: AttachmentRef[]; breaks?: boolean }>();

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
    },
  ],
});

// Token stream rendered straight to VNodes (MdTokens) — no HTML string, no
// v-html, no sanitizer to bypass. In `breaks` mode (chat messages) a single
// newline becomes a hard break so multi-line messages keep their line breaks;
// notes leave it off (standard markdown soft-wrap). The merge with
// `marked.defaults` preserves the registered highlight/spoiler extensions.
const tokens = computed(() =>
  props.breaks
    ? marked.lexer(props.source, { ...marked.defaults, breaks: true })
    : marked.lexer(props.source),
);

// attachment images: decrypt to object URLs, cached per id
const urlCache = new Map<string, Promise<string | null>>();
const objectUrls: string[] = [];

function resolveAttachment(id: string): Promise<string | null> {
  let cached = urlCache.get(id);
  if (!cached) {
    cached = (async () => {
      const ref = props.attachments?.find((a) => a.id === id);
      if (!ref) return null;
      try {
        const ct = await api.attachmentDownload(ref.id);
        const data = await decryptBlob(ct, ref.key, ref.iv);
        const url = URL.createObjectURL(new Blob([data as BlobPart], { type: ref.type }));
        objectUrls.push(url);
        return url;
      } catch {
        return null;
      }
    })();
    urlCache.set(id, cached);
  }
  return cached;
}

watch(
  () => props.attachments,
  () => urlCache.clear(),
);

onBeforeUnmount(() => {
  for (const url of objectUrls) URL.revokeObjectURL(url);
});

const root = ref<HTMLDivElement>();

// click-to-reveal spoilers, cmd/ctrl+click to re-conceal (delegated)
function onClick(event: MouseEvent) {
  const spoiler = (event.target as HTMLElement).closest('.spoiler');
  if (!spoiler || !root.value?.contains(spoiler)) return;
  if (!spoiler.classList.contains('spoiler-revealed')) {
    spoiler.classList.add('spoiler-revealed');
    event.preventDefault();
  } else if (event.metaKey || event.ctrlKey) {
    spoiler.classList.remove('spoiler-revealed');
    event.preventDefault();
  }
}
</script>

<template>
  <div ref="root" class="md-preview" @click="onClick">
    <MdTokens :tokens="tokens" :resolve="resolveAttachment" />
  </div>
</template>
