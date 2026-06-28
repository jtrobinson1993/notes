<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { formatBytes } from '../lib/fileMeta';
import IconPlay from '~icons/mynaui/play-solid';
import IconPause from '~icons/mynaui/pause-solid';
import IconMusic from '~icons/mynaui/music';

// Custom, theme-matching audio player: the native <audio> is hidden and driven
// by JS so the controls use the app's own tokens (blue accent, zinc surfaces,
// dark-mode variants) instead of the browser's chrome.
const props = defineProps<{ src: string; name: string; size?: number }>();

const audio = ref<HTMLAudioElement>();
const playing = ref(false);
const current = ref(0);
const duration = ref(0);

const progress = computed(() => (duration.value > 0 ? Math.min(1, current.value / duration.value) : 0));
const pct = computed(() => `${progress.value * 100}%`);

function toggle() {
  const el = audio.value;
  if (!el) return;
  if (el.paused) void el.play();
  else el.pause();
}

function onMeta() {
  const d = audio.value?.duration ?? 0;
  duration.value = Number.isFinite(d) ? d : 0;
}

function onEnded() {
  playing.value = false;
  current.value = 0;
}

// ---- seeking (pointer drag + click on the track) ----------------------------
const track = ref<HTMLElement>();
let seeking = false;
function seekToClientX(clientX: number) {
  const el = audio.value;
  const rect = track.value?.getBoundingClientRect();
  if (!el || !rect || !duration.value) return;
  const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  el.currentTime = frac * duration.value;
  current.value = el.currentTime;
}
function onPointerDown(e: PointerEvent) {
  seeking = true;
  track.value?.setPointerCapture(e.pointerId);
  seekToClientX(e.clientX);
}
function onPointerMove(e: PointerEvent) {
  if (seeking) seekToClientX(e.clientX);
}
function onPointerUp(e: PointerEvent) {
  seeking = false;
  track.value?.releasePointerCapture(e.pointerId);
}
function onKey(e: KeyboardEvent) {
  const el = audio.value;
  if (!el) return;
  if (e.key === 'ArrowLeft') el.currentTime = Math.max(0, el.currentTime - 5);
  else if (e.key === 'ArrowRight') el.currentTime = Math.min(duration.value, el.currentTime + 5);
  else if (e.key === ' ' || e.key === 'Enter') toggle();
  else return;
  current.value = el.currentTime;
  e.preventDefault();
}

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

onBeforeUnmount(() => audio.value?.pause());
</script>

<template>
  <div class="flex max-w-[360px] items-center gap-3 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-700">
    <audio
      ref="audio"
      :src="src"
      preload="metadata"
      class="hidden"
      @timeupdate="current = audio?.currentTime ?? 0"
      @loadedmetadata="onMeta"
      @durationchange="onMeta"
      @play="playing = true"
      @pause="playing = false"
      @ended="onEnded"
    />

    <button
      type="button"
      :aria-label="playing ? 'Pause' : 'Play'"
      class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white transition-colors hover:bg-blue-500"
      @click="toggle"
    >
      <IconPause v-if="playing" class="h-5 w-5" />
      <IconPlay v-else class="h-5 w-5 translate-x-px" />
    </button>

    <div class="min-w-0 grow">
      <div class="mb-1 flex items-center gap-1.5 text-xs">
        <IconMusic class="h-3.5 w-3.5 shrink-0 text-zinc-500" />
        <span class="min-w-0 truncate font-medium">{{ name }}</span>
        <span v-if="size" class="ml-auto shrink-0 text-zinc-500">{{ formatBytes(size) }}</span>
      </div>

      <div class="flex items-center gap-2">
        <div
          ref="track"
          role="slider"
          tabindex="0"
          aria-label="Seek"
          :aria-valuemin="0"
          :aria-valuemax="Math.round(duration)"
          :aria-valuenow="Math.round(current)"
          class="group relative h-1.5 grow cursor-pointer touch-none rounded-full bg-zinc-200 dark:bg-zinc-700"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @keydown="onKey"
        >
          <div class="absolute inset-y-0 left-0 rounded-full bg-blue-600 dark:bg-blue-400" :style="{ width: pct }" />
          <div
            class="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-600 opacity-0 shadow transition-opacity group-hover:opacity-100 dark:bg-blue-400"
            :style="{ left: pct }"
          />
        </div>
        <span class="shrink-0 text-[11px] tabular-nums text-zinc-500">{{ fmt(current) }} / {{ fmt(duration) }}</span>
      </div>
    </div>
  </div>
</template>
