<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watchEffect } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { AttachmentRef } from '@notes/shared';
import { api } from '../lib/api';
import { decryptBlob } from '../lib/crypto';

const props = defineProps<{ source: string; attachments?: AttachmentRef[] }>();

// allow the attachment: scheme used for encrypted embedded images
const URI_RE = /^(?:(?:https?|mailto|tel|attachment):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

const html = computed(() =>
  DOMPurify.sanitize(marked.parse(props.source, { async: false }), { ALLOWED_URI_REGEXP: URI_RE }),
);

const root = ref<HTMLDivElement>();
const objectUrls: string[] = [];

// Resolve attachment: image sources to decrypted blob URLs.
watchEffect(async () => {
  void html.value;
  const el = root.value;
  if (!el) return;
  await new Promise((r) => requestAnimationFrame(r));
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
  <div ref="root" class="md-preview" v-html="html" />
</template>
