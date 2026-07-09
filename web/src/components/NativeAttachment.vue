<script setup lang="ts">
// Renders one v8 message attachment (D6): fetches + decrypts the blob on demand
// (attachmentFetch), shows images inline via an object URL, everything else as a
// download chip. The per-file key/iv travel in the ref; the relay only ever held
// ciphertext.
import { computed, onMounted, onUnmounted, ref } from 'vue';
import IconPaperclip from '~icons/mynaui/paperclip';
import { attachmentFetch, type MessageAttachment } from '../lib/native';

const props = defineProps<{
  attachment: MessageAttachment;
  kind: 'dm' | 'group';
  targetId: string;
}>();

const url = ref<string | null>(null);
const error = ref(false);
const isImage = computed(() => props.attachment.mime.startsWith('image/'));

async function fetchUrl(): Promise<string | null> {
  try {
    const bytes = await attachmentFetch(props.kind, props.targetId, props.attachment);
    return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: props.attachment.mime }));
  } catch {
    error.value = true;
    return null;
  }
}

onMounted(async () => {
  if (isImage.value) url.value = await fetchUrl();
});
onUnmounted(() => {
  if (url.value) URL.revokeObjectURL(url.value);
});

async function download(): Promise<void> {
  const href = url.value ?? (await fetchUrl());
  if (!href) return;
  const a = document.createElement('a');
  a.href = href;
  a.download = props.attachment.name;
  a.click();
}
</script>

<template>
  <img
    v-if="isImage && url"
    :src="url"
    :alt="attachment.name"
    class="max-w-[240px] rounded-lg"
    data-testid="attach-image"
  />
  <button
    v-else
    data-testid="attach-download"
    class="flex items-center gap-1 rounded-lg bg-neutral-500/15 px-2 py-1 text-xs"
    @click="download"
  >
    <IconPaperclip class="h-3.5 w-3.5" />
    <span class="max-w-[200px] truncate">{{ attachment.name }}</span>
    <span v-if="error" class="text-red-500">(failed)</span>
  </button>
</template>
