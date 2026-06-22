<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import IconX from '~icons/mynaui/x';
import { formatBytes, formatMime } from '../lib/fileMeta';
import {
  CLICK_ZOOM,
  clampPan,
  clampScale,
  MIN_SCALE,
  type Point,
  zoomToPoint,
} from '../lib/imageZoom';

/**
 * Full-bleed image viewer. Click toggles between fit and a zoomed-in view
 * anchored on the cursor; click-and-hold drags (pans) when zoomed. Built on
 * reka-ui's Dialog so Escape / overlay-click / the close button all dismiss it.
 *
 * Fully controlled (no optimistic local `open`): the parent owns visibility so
 * it can wrap open/close in a view transition without the dialog tearing down
 * before the morph captures its snapshot. `viewTransitionName`, when set, is the
 * shared name that morphs this image to/from its inline thumbnail.
 */
const props = defineProps<{
  open: boolean;
  src: string;
  alt: string;
  /** Optional metadata shown in the corner overlay. */
  name?: string;
  size?: number;
  type?: string;
  viewTransitionName?: string;
}>();
const emit = defineEmits<{ 'update:open': [boolean] }>();

const close = () => emit('update:open', false);

const img = ref<HTMLImageElement | null>(null);
const scale = ref(MIN_SCALE);
const pan = ref<Point>({ x: 0, y: 0 });
// `dragging` drives the cursor, so it must be reactive (a plain `let` wouldn't
// re-render the class and the grab cursor would stick after a drag).
const dragging = ref(false);
const dims = ref<{ w: number; h: number } | null>(null);

// Pixel dimensions · size · format, dropping any parts we don't have.
const metaLine = computed(() =>
  [
    dims.value ? `${dims.value.w}×${dims.value.h}` : null,
    props.size != null ? formatBytes(props.size) : null,
    props.type ? formatMime(props.type) : null,
  ]
    .filter(Boolean)
    .join(' · '),
);

// Distinguish a click (zoom) from a drag (pan): a pointer that moves past this
// many px between down and up counts as a drag and is not treated as a click.
const DRAG_THRESHOLD = 4;
let moved = false;
let startX = 0;
let startY = 0;
let panAtStart: Point = { x: 0, y: 0 };

function reset() {
  scale.value = MIN_SCALE;
  pan.value = { x: 0, y: 0 };
  dragging.value = false;
  moved = false;
}

function onLoad(e: Event) {
  const el = e.target as HTMLImageElement;
  dims.value = { w: el.naturalWidth, h: el.naturalHeight };
}

// Fresh image each time it opens.
watch(
  () => props.open,
  (v) => {
    if (v) {
      reset();
      dims.value = null;
    }
  },
);

/** Cursor offset from the image's current on-screen centre, in px. */
function relToCentre(e: PointerEvent | MouseEvent): Point {
  const r = img.value!.getBoundingClientRect();
  return { x: e.clientX - (r.left + r.width / 2), y: e.clientY - (r.top + r.height / 2) };
}

function applyScale(next: number, rel: Point) {
  const s1 = clampScale(next);
  const el = img.value!;
  const moved2 = s1 === MIN_SCALE ? { x: 0, y: 0 } : zoomToPoint(pan.value, scale.value, s1, rel);
  scale.value = s1;
  pan.value = clampPan(moved2, s1, el.clientWidth, el.clientHeight);
}

function onPointerDown(e: PointerEvent) {
  dragging.value = true;
  moved = false;
  startX = e.clientX;
  startY = e.clientY;
  panAtStart = { ...pan.value };
  img.value!.setPointerCapture(e.pointerId);
}

function onPointerMove(e: PointerEvent) {
  if (!dragging.value) return;
  const dx = e.clientX - startX;
  const dy = e.clientY - startY;
  if (!moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) moved = true;
  if (scale.value === MIN_SCALE) return; // nothing to pan at fit scale
  const el = img.value!;
  pan.value = clampPan(
    { x: panAtStart.x + dx, y: panAtStart.y + dy },
    scale.value,
    el.clientWidth,
    el.clientHeight,
  );
}

function onPointerUp(e: PointerEvent) {
  if (!dragging.value) return;
  dragging.value = false;
  img.value!.releasePointerCapture(e.pointerId);
  if (moved) return; // it was a drag, not a click
  // A plain click toggles: fit → zoomed-at-cursor, or back to fit.
  if (scale.value === MIN_SCALE) applyScale(CLICK_ZOOM, relToCentre(e));
  else applyScale(MIN_SCALE, { x: 0, y: 0 });
}

function onWheel(e: WheelEvent) {
  e.preventDefault();
  applyScale(scale.value * (e.deltaY < 0 ? 1.15 : 1 / 1.15), relToCentre(e));
}
</script>

<template>
  <DialogRoot :open="open" @update:open="(v) => emit('update:open', v)">
    <DialogPortal>
      <DialogOverlay class="lb-overlay fixed inset-0 z-lightbox bg-black/80 backdrop-blur-sm" />
      <DialogContent
        class="app-safe fixed inset-0 z-lightbox flex items-center justify-center overflow-hidden focus:outline-none"
        @pointerdown.self="close"
      >
        <DialogTitle class="sr-only">{{ alt || 'Image' }}</DialogTitle>
        <img
          ref="img"
          :src="src"
          :alt="alt"
          draggable="false"
          class="max-h-[92vh] max-w-[92vw] select-none touch-none rounded-lg shadow-2xl"
          :class="
            scale > MIN_SCALE ? (dragging ? 'cursor-grabbing' : 'cursor-zoom-out') : 'cursor-zoom-in'
          "
          :style="{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            transition: dragging ? 'none' : 'transform 150ms ease-out',
            viewTransitionName,
          }"
          @load="onLoad"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @wheel="onWheel"
        />
        <button
          type="button"
          class="lb-chrome absolute right-4 top-4 rounded-lg p-2 text-white/80 hover:bg-white/10 hover:text-white focus:outline-none"
          aria-label="Close"
          @click="close"
        >
          <IconX class="h-6 w-6" />
        </button>
        <div
          v-if="name"
          class="lb-chrome pointer-events-none absolute bottom-4 right-4 max-w-[80vw] rounded-lg bg-black/55 px-3 py-2 text-right text-xs text-white/90 backdrop-blur-sm"
        >
          <div class="truncate font-medium">{{ name }}</div>
          <div v-if="metaLine" class="mt-0.5 text-white/55">{{ metaLine }}</div>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
