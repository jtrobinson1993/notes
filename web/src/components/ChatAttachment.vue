<script setup lang="ts">
import { ref } from 'vue';
import type { AttachmentRef } from '@notes/shared';
import { decryptAttachment } from '../lib/attachments';
import { formatBytes } from '../lib/fileMeta';
import IconPaperclip from '~icons/mynaui/paperclip';
import IconDanger from '~icons/mynaui/danger-triangle';

/**
 * A non-image chat attachment, rendered as a download chip. Inline images are
 * handled by `ChatImageGrid.vue` instead; the splitting happens one level up in
 * `ChatAttachments.vue`. Decryption is local (no remote fetch, no IP leak).
 */
const props = defineProps<{ attachment: AttachmentRef }>();

const failed = ref(false);

async function download() {
  let data: Uint8Array;
  try {
    data = await decryptAttachment(props.attachment);
  } catch {
    failed.value = true;
    return;
  }
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: props.attachment.type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = props.attachment.name;
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <button
    type="button"
    :title="failed ? 'Could not decrypt' : `Download ${attachment.name}`"
    class="mt-1 flex max-w-[320px] items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
    @click="download"
  >
    <IconDanger v-if="failed" class="h-5 w-5 shrink-0 text-amber-500" />
    <IconPaperclip v-else class="h-5 w-5 shrink-0" />
    <span class="min-w-0">
      <span class="block truncate font-medium">{{ attachment.name }}</span>
      <span class="block text-xs text-zinc-500">{{ failed ? 'could not decrypt' : formatBytes(attachment.size) }}</span>
    </span>
  </button>
</template>
