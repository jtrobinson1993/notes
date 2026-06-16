<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { AttachmentRef } from '@notes/shared';
import { api } from '../lib/api';
import { decryptBlob } from '../lib/crypto';
import { formatBytes } from '../lib/fileMeta';
import { withViewTransition } from '../lib/viewTransition';
import ImageLightbox from './ImageLightbox.vue';
import IconPaperclip from '~icons/mynaui/paperclip';
import IconDanger from '~icons/mynaui/danger-triangle';

const props = defineProps<{ attachment: AttachmentRef }>();

const isImage = props.attachment.type.startsWith('image/');
const imgUrl = ref<string | null>(null);
const failed = ref(false);
const lightboxOpen = ref(false);
let objectUrl: string | null = null;
let blobData: Uint8Array | null = null;

// Shared `view-transition-name` so the thumbnail morphs into (and back out of)
// the lightbox image. Only assigned while a transition is in flight so static
// images add no snapshot overhead; the thumbnail carries it when closed and the
// modal image when open (see the gated bindings below). Sanitised to a valid
// CSS custom-ident.
const vtName = `chat-img-${props.attachment.id}`.replace(/[^\w-]/g, '-');
const morphing = ref(false);

/** Toggle the lightbox, morphing the thumbnail ⇄ modal image when supported. */
async function setOpen(open: boolean) {
  morphing.value = true;
  await nextTick(); // assign the name to the source element before snapshotting
  await withViewTransition(
    async () => {
      lightboxOpen.value = open;
      await nextTick(); // let the target element mount/unmount before the new snapshot
    },
    {},
    // Morph only the image; the lightbox backdrop and chrome animate via CSS.
    { excludeRoot: true },
  );
  morphing.value = false;
}

/** Decrypt the blob once; cached for both inline display and download. */
async function load(): Promise<Uint8Array | null> {
  if (blobData) return blobData;
  try {
    const ct = await api.attachmentDownload(props.attachment.id);
    blobData = await decryptBlob(ct, props.attachment.key, props.attachment.iv);
    return blobData;
  } catch {
    failed.value = true;
    return null;
  }
}

onMounted(async () => {
  if (!isImage) return;
  const data = await load();
  if (!data) return;
  objectUrl = URL.createObjectURL(new Blob([data as BlobPart], { type: props.attachment.type }));
  imgUrl.value = objectUrl;
});

async function download() {
  const data = await load();
  if (!data) return;
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: props.attachment.type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = props.attachment.name;
  a.click();
  URL.revokeObjectURL(url);
}

onBeforeUnmount(() => {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
});
</script>

<template>
  <!-- Decrypted locally → no remote fetch, so no IP leak (see spec/security.md). -->
  <template v-if="isImage && imgUrl">
    <button
      type="button"
      class="mt-1 block cursor-zoom-in rounded-lg"
      :title="`View ${attachment.name}`"
      @click="setOpen(true)"
    >
      <img
        :src="imgUrl"
        :alt="attachment.name"
        class="max-h-80 max-w-[320px] rounded-lg"
        loading="lazy"
        :style="{ viewTransitionName: morphing && !lightboxOpen ? vtName : undefined }"
      />
    </button>
    <ImageLightbox
      :open="lightboxOpen"
      :src="imgUrl"
      :alt="attachment.name"
      :name="attachment.name"
      :size="attachment.size"
      :type="attachment.type"
      :view-transition-name="morphing && lightboxOpen ? vtName : undefined"
      @update:open="setOpen"
    />
  </template>
  <button
    v-else
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
