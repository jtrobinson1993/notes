<script setup lang="ts">
import { ref } from 'vue';
import type { LinkPreview } from '@notes/shared';
import { clickToLoadImages } from '../lib/privacy';

const props = defineProps<{ preview: LinkPreview }>();

// The preview image is a remote URL, so loading it leaks the viewer's IP to that
// host — gate it behind the same click-to-load setting as any remote image.
const showImage = ref(!clickToLoadImages.value);

let host = '';
try {
  host = new URL(props.preview.url).hostname.replace(/^www\./, '');
} catch {
  /* leave blank */
}
</script>

<template>
  <a
    :href="preview.url"
    target="_blank"
    rel="noopener noreferrer nofollow"
    class="mt-1 flex max-w-md overflow-hidden rounded-lg border border-zinc-200 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800/50"
  >
    <div class="min-w-0 grow p-2.5">
      <p class="truncate text-[11px] uppercase tracking-wide text-zinc-400">
        {{ preview.siteName || host }}
      </p>
      <p v-if="preview.title" class="mt-0.5 line-clamp-2 text-sm font-medium text-zinc-800 dark:text-zinc-100">
        {{ preview.title }}
      </p>
      <p v-if="preview.description" class="mt-0.5 line-clamp-2 text-xs text-zinc-500 dark:text-zinc-400">
        {{ preview.description }}
      </p>
    </div>
    <div v-if="preview.image" class="shrink-0">
      <img v-if="showImage" :src="preview.image" alt="" class="h-full max-h-24 w-24 object-cover" />
      <button
        v-else
        type="button"
        class="flex h-full min-h-16 w-24 items-center justify-center bg-zinc-100 px-1 text-center text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
        @click.prevent="showImage = true"
      >
        🖼 Load image
      </button>
    </div>
  </a>
</template>
