<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppModal from './AppModal.vue';
import {
  AVATAR_SIZE,
  clampOffset,
  coverScale,
  cropToDataUrl,
  loadImageFromFile,
  sourceRect,
} from '../lib/avatar';

const open = defineModel<boolean>('open', { default: false });
const props = defineProps<{ file: File | null }>();
const emit = defineEmits<{ cropped: [dataUrl: string] }>();

// Fixed square viewport (CSS px) the crop math is expressed in.
const VIEWPORT = 256;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

const img = ref<HTMLImageElement | null>(null);
const zoom = ref(1);
const offsetX = ref(0);
const offsetY = ref(0);
const loading = ref(false);
const busy = ref(false);
const error = ref('');

const baseScale = computed(() => (img.value ? coverScale(img.value.naturalWidth, img.value.naturalHeight, VIEWPORT) : 1));
const effScale = computed(() => baseScale.value * zoom.value);
const displayW = computed(() => (img.value?.naturalWidth ?? 0) * effScale.value);
const displayH = computed(() => (img.value?.naturalHeight ?? 0) * effScale.value);

function clamp() {
  offsetX.value = clampOffset(offsetX.value, displayW.value, VIEWPORT);
  offsetY.value = clampOffset(offsetY.value, displayH.value, VIEWPORT);
}

// Load (or reset) whenever the modal opens with a file.
watch(
  [open, () => props.file],
  async ([o, file]) => {
    revoke();
    img.value = null;
    error.value = '';
    zoom.value = 1;
    if (!o || !file) return;
    loading.value = true;
    try {
      const el = await loadImageFromFile(file);
      img.value = el;
      // Center the image in the frame at minimum zoom.
      offsetX.value = (VIEWPORT - el.naturalWidth * baseScale.value) / 2;
      offsetY.value = (VIEWPORT - el.naturalHeight * baseScale.value) / 2;
      clamp();
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Could not load image.';
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);

function revoke() {
  if (img.value?.src.startsWith('blob:')) URL.revokeObjectURL(img.value.src);
}

// Center-anchored zoom: the point under the frame center stays put.
function setZoom(z: number) {
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
  const oldScale = effScale.value;
  const newScale = baseScale.value * next;
  const c = VIEWPORT / 2;
  offsetX.value = c - (c - offsetX.value) * (newScale / oldScale);
  offsetY.value = c - (c - offsetY.value) * (newScale / oldScale);
  zoom.value = next;
  clamp();
}

// Pointer drag to pan.
let dragging = false;
let lastX = 0;
let lastY = 0;
function onPointerDown(e: PointerEvent) {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  (e.target as HTMLElement).setPointerCapture(e.pointerId);
}
function onPointerMove(e: PointerEvent) {
  if (!dragging) return;
  offsetX.value += e.clientX - lastX;
  offsetY.value += e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  clamp();
}
function onPointerUp(e: PointerEvent) {
  dragging = false;
  (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
}
function onWheel(e: WheelEvent) {
  e.preventDefault();
  setZoom(zoom.value - Math.sign(e.deltaY) * 0.15);
}

async function confirm() {
  if (!img.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const { sx, sy, size } = sourceRect(offsetX.value, offsetY.value, effScale.value, VIEWPORT);
    const dataUrl = await cropToDataUrl(img.value, sx, sy, size);
    emit('cropped', dataUrl);
    open.value = false;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not process the image.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AppModal v-model:open="open" title="Crop avatar" description="Drag to position, scroll or use the slider to zoom." max-width="sm:max-w-sm">
    <div class="flex flex-col items-center gap-4 pb-4">
      <p v-if="loading" class="py-12 text-sm text-zinc-400">Loading…</p>
      <template v-else-if="img">
        <!-- Square crop frame with a circular mask preview. -->
        <div
          class="relative cursor-move touch-none overflow-hidden rounded-lg bg-zinc-100 dark:bg-zinc-800"
          :style="{ width: `${VIEWPORT}px`, height: `${VIEWPORT}px` }"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
          @wheel="onWheel"
        >
          <img
            :src="img.src"
            alt=""
            draggable="false"
            class="pointer-events-none absolute max-w-none select-none"
            :style="{ width: `${displayW}px`, height: `${displayH}px`, left: `${offsetX}px`, top: `${offsetY}px` }"
          />
          <!-- Circular overlay hint showing the avatar shape. -->
          <div class="pointer-events-none absolute inset-0 rounded-lg shadow-[inset_0_0_0_9999px_rgba(0,0,0,0.35)] [clip-path:circle(50%)]" />
          <div class="pointer-events-none absolute inset-0 rounded-full ring-2 ring-white/70" />
        </div>

        <input
          type="range"
          :min="MIN_ZOOM"
          :max="MAX_ZOOM"
          step="0.01"
          :value="zoom"
          class="w-full accent-blue-600"
          aria-label="Zoom"
          @input="setZoom(Number(($event.target as HTMLInputElement).value))"
        />
      </template>

      <p v-if="error" class="text-sm text-red-600 dark:text-red-400">{{ error }}</p>
    </div>

    <template #footer>
      <button
        class="rounded-lg px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
        @click="open = false"
      >
        Cancel
      </button>
      <button
        class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        :disabled="!img || busy"
        @click="confirm"
      >
        {{ busy ? 'Processing…' : 'Use photo' }}
      </button>
    </template>
  </AppModal>
</template>
