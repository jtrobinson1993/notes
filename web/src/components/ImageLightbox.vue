<script setup lang="ts">
import { ref, watch } from 'vue';
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import IconX from '~icons/mynaui/x';
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
 */
const props = defineProps<{ src: string; alt: string }>();
const open = defineModel<boolean>('open', { default: false });

const img = ref<HTMLImageElement | null>(null);
const scale = ref(MIN_SCALE);
const pan = ref<Point>({ x: 0, y: 0 });

// Distinguish a click (zoom) from a drag (pan): a pointer that moves past this
// many px between down and up counts as a drag and is not treated as a click.
const DRAG_THRESHOLD = 4;
let dragging = false;
let moved = false;
let startX = 0;
let startY = 0;
let panAtStart: Point = { x: 0, y: 0 };

function reset() {
  scale.value = MIN_SCALE;
  pan.value = { x: 0, y: 0 };
  dragging = false;
  moved = false;
}

// Fresh image each time it opens.
watch(open, (v) => {
  if (v) reset();
});

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
  dragging = true;
  moved = false;
  startX = e.clientX;
  startY = e.clientY;
  panAtStart = { ...pan.value };
  img.value!.setPointerCapture(e.pointerId);
}

function onPointerMove(e: PointerEvent) {
  if (!dragging) return;
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
  if (!dragging) return;
  dragging = false;
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
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-black/80 backdrop-blur-sm" />
      <DialogContent
        class="fixed inset-0 z-50 flex items-center justify-center overflow-hidden focus:outline-none"
        @pointerdown.self="open = false"
      >
        <DialogTitle class="sr-only">{{ alt || 'Image' }}</DialogTitle>
        <img
          ref="img"
          :src="src"
          :alt="alt"
          draggable="false"
          class="max-h-[92vh] max-w-[92vw] select-none touch-none rounded-lg shadow-2xl"
          :class="
            scale > MIN_SCALE ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in'
          "
          :style="{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            transition: dragging ? 'none' : 'transform 150ms ease-out',
          }"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @wheel="onWheel"
        />
        <button
          type="button"
          class="absolute right-4 top-4 rounded-lg p-2 text-white/80 hover:bg-white/10 hover:text-white focus:outline-none"
          aria-label="Close"
          @click="open = false"
        >
          <IconX class="h-6 w-6" />
        </button>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
