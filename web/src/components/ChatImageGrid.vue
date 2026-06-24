<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { AttachmentRef } from '@notes/shared';
import { decryptAttachment } from '../lib/attachments';
import { galleryLayout, stepIndex, tileMetrics, TILE_HEIGHT, TILE_MIN_WIDTH } from '../lib/imageGallery';
import { withViewTransition } from '../lib/viewTransition';
import ImageLightbox from './ImageLightbox.vue';
import IconDanger from '~icons/mynaui/danger-triangle';

/**
 * The image attachments of a single chat message, laid out as a wrapping strip
 * of equal-height, uncropped thumbnails (so each shows whole, letterboxed against
 * the tile background, and the open/close morph into the lightbox stays true).
 * Up to `MAX_GALLERY_TILES` show inline; the last visible tile collapses the
 * remainder behind a `+N` badge that drops you into the lightbox at that image so
 * the arrows reveal the rest. Sizing math lives in the pure, unit-tested
 * `lib/imageGallery.ts`.
 */
const props = defineProps<{ images: AttachmentRef[] }>();

// Decrypted object URLs, index-aligned with `props.images`. `null` = still
// loading or failed (failed[i] disambiguates). Decryption is local, so there's
// no remote fetch and no IP leak (see spec/security.md).
const urls = ref<(string | null)[]>(props.images.map(() => null));
const failed = ref<boolean[]>(props.images.map(() => false));
// Natural pixel dimensions per image, filled on <img> load; drives each tile's
// width so the strip is equal-height with true aspect ratios.
const dims = ref<({ w: number; h: number } | null)[]>(props.images.map(() => null));
const objectUrls: string[] = [];

const layout = computed(() => galleryLayout(props.images.length));

const lightboxOpen = ref(false);
const index = ref(0);
const current = computed(() => props.images[index.value]);
const currentUrl = computed(() => urls.value[index.value]);
const hasPrev = computed(() => index.value > 0);
const hasNext = computed(() => index.value < props.images.length - 1);

/** Per-tile width + crop mode from the loaded natural size (min-width fallback
 *  until the image reports its dimensions). */
function metrics(i: number) {
  const d = dims.value[i];
  return d ? tileMetrics(d.w, d.h) : { width: TILE_MIN_WIDTH, fit: 'contain' as const };
}

function onImgLoad(i: number, e: Event) {
  const el = e.target as HTMLImageElement;
  dims.value[i] = { w: el.naturalWidth, h: el.naturalHeight };
}

onMounted(() => {
  props.images.forEach(async (att, i) => {
    try {
      const data = await decryptAttachment(att);
      const url = URL.createObjectURL(new Blob([data as BlobPart], { type: att.type }));
      objectUrls.push(url);
      urls.value[i] = url;
    } catch {
      failed.value[i] = true;
    }
  });
});

onBeforeUnmount(() => {
  for (const u of objectUrls) URL.revokeObjectURL(u);
});

// Shared `view-transition-name` so a thumbnail morphs into (and back out of) the
// modal image. Only assigned while a transition is in flight, and only for the
// image currently shown — so navigating between photos doesn't morph, just open
// and close. Sanitised to a valid CSS custom-ident.
const morphing = ref(false);
const vtName = computed(() => `chat-img-${current.value?.id ?? ''}`.replace(/[^\w-]/g, '-'));
// The morph only has a thumbnail to pair with when the shown image is a visible
// tile (images hidden behind `+N` have no tile, so they just cross-fade).
const currentIsTile = computed(() => index.value < layout.value.visibleCount);

/** Open/close the lightbox, morphing the active thumbnail ⇄ modal image. */
async function setOpen(open: boolean) {
  morphing.value = currentIsTile.value;
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

function openAt(i: number) {
  if (!urls.value[i]) return; // not decrypted (or failed) → nothing to show
  index.value = i;
  setOpen(true);
}

function step(delta: number) {
  index.value = stepIndex(index.value, delta, props.images.length);
}
</script>

<template>
  <div class="mt-1 flex max-w-full flex-wrap gap-1">
    <template v-for="(att, i) in images" :key="att.id">
      <!-- Only the first `visibleCount` tiles render; the rest hide behind the
           `+N` badge on the last visible one. Equal height, width from the
           image's aspect ratio, off-colored background = the letterbox/fallback. -->
      <button
        v-if="i < layout.visibleCount"
        type="button"
        class="relative block shrink-0 cursor-zoom-in overflow-hidden rounded-lg bg-zinc-200/70 dark:bg-zinc-700/50"
        :style="{ height: `${TILE_HEIGHT}px`, width: `${metrics(i).width}px` }"
        :title="`View ${att.name}`"
        @click="openAt(i)"
      >
        <img
          v-if="urls[i]"
          :src="urls[i]!"
          :alt="att.name"
          loading="lazy"
          class="h-full w-full"
          :class="metrics(i).fit === 'cover' ? 'object-cover' : 'object-contain'"
          :style="{
            viewTransitionName:
              morphing && !lightboxOpen && i === index ? vtName : undefined,
          }"
          @load="onImgLoad(i, $event)"
        />
        <!-- Decrypt failed: muted placeholder so the strip still tiles cleanly. -->
        <span
          v-else-if="failed[i]"
          class="flex h-full w-full items-center justify-center text-amber-500"
        >
          <IconDanger class="h-6 w-6" />
        </span>
        <!-- +N overlay on the last visible tile when images overflow the cap. -->
        <span
          v-if="layout.overflow && i === layout.visibleCount - 1"
          class="absolute inset-0 flex items-center justify-center bg-black/55 text-2xl font-semibold text-white"
        >
          +{{ layout.overflow }}
        </span>
      </button>
    </template>
  </div>

  <ImageLightbox
    v-if="current && currentUrl"
    :open="lightboxOpen"
    :src="currentUrl"
    :alt="current.name"
    :name="current.name"
    :size="current.size"
    :type="current.type"
    :has-prev="hasPrev"
    :has-next="hasNext"
    :view-transition-name="morphing && lightboxOpen ? vtName : undefined"
    @update:open="setOpen"
    @prev="step(-1)"
    @next="step(1)"
  />
</template>
