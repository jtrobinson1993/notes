<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import type { AttachmentRef } from '@notes/shared';
import { decryptAttachment } from '../lib/attachments';
import { formatBytes } from '../lib/fileMeta';
import AudioPlayer from './AudioPlayer.vue';
import IconPlay from '~icons/mynaui/play';
import IconMusic from '~icons/mynaui/music';
import IconDanger from '~icons/mynaui/danger-triangle';

/**
 * An audio/video chat attachment played inline. Like images, the blob is
 * decrypted locally to an object URL (no remote fetch, no IP leak). Audio loads
 * straight away (small); video is click-to-load, since the whole file must be
 * decrypted to play and clips can be large.
 */
const props = defineProps<{ attachment: AttachmentRef; kind: 'audio' | 'video' }>();

const url = ref<string | null>(null);
const failed = ref(false);
const loading = ref(false);

async function load() {
  if (url.value || loading.value) return;
  loading.value = true;
  try {
    const data = await decryptAttachment(props.attachment);
    url.value = URL.createObjectURL(new Blob([data as BlobPart], { type: props.attachment.type }));
  } catch {
    failed.value = true;
  } finally {
    loading.value = false;
  }
}

// Audio loads eagerly; video waits for an explicit click.
if (props.kind === 'audio') void load();

onBeforeUnmount(() => {
  if (url.value) URL.revokeObjectURL(url.value);
});
</script>

<template>
  <div class="mt-1 max-w-[360px]">
    <!-- Decrypt failed: a non-interactive error chip. -->
    <div
      v-if="failed"
      class="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700"
    >
      <IconDanger class="h-5 w-5 shrink-0 text-amber-500" />
      <span class="min-w-0">
        <span class="block truncate font-medium">{{ attachment.name }}</span>
        <span class="block text-xs text-zinc-500">could not decrypt</span>
      </span>
    </div>

    <!-- Audio: custom themed player (filename + scrubber). -->
    <AudioPlayer
      v-else-if="kind === 'audio' && url"
      :src="url"
      :name="attachment.name"
      :size="attachment.size"
    />
    <!-- Audio still decrypting. -->
    <div
      v-else-if="kind === 'audio'"
      class="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-2 text-xs dark:border-zinc-700"
    >
      <IconMusic class="h-3.5 w-3.5 shrink-0 text-zinc-500" />
      <span class="min-w-0 truncate font-medium">{{ attachment.name }}</span>
      <span class="ml-auto shrink-0 text-zinc-500">Loading…</span>
    </div>

    <!-- Video, loaded: native controls. -->
    <video
      v-else-if="url"
      :src="url"
      controls
      autoplay
      preload="metadata"
      class="w-full rounded-lg bg-black"
      :aria-label="attachment.name"
    />

    <!-- Video, not yet loaded: click-to-load placeholder. -->
    <button
      v-else
      type="button"
      :disabled="loading"
      :title="`Play ${attachment.name}`"
      class="flex w-full items-center gap-3 rounded-lg border border-zinc-200 px-3 py-3 text-left text-sm hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800"
      @click="load"
    >
      <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white dark:bg-white dark:text-zinc-900">
        <IconPlay class="h-5 w-5" />
      </span>
      <span class="min-w-0">
        <span class="block truncate font-medium">{{ attachment.name }}</span>
        <span class="block text-xs text-zinc-500">{{ loading ? 'Loading…' : `Video · ${formatBytes(attachment.size)}` }}</span>
      </span>
    </button>
  </div>
</template>
