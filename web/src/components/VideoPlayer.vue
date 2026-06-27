<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import IconPlay from '~icons/mynaui/play-solid';
import IconPause from '~icons/mynaui/pause-solid';
import IconMaximize from '~icons/mynaui/maximize';

// Custom, theme-matching video controls: the native <video controls> chrome is
// dropped for our own overlay — a centered play button when paused (so a paused
// clip doesn't read as a static image) plus a bottom bar (play/pause, seek,
// time, fullscreen) that shows on hover or while paused.
const props = defineProps<{ src: string; name?: string }>();

const container = ref<HTMLElement>();
const video = ref<HTMLVideoElement>();
const playing = ref(false);
const current = ref(0);
const duration = ref(0);
const hovering = ref(false);

const progress = computed(() => (duration.value > 0 ? Math.min(1, current.value / duration.value) : 0));
const pct = computed(() => `${progress.value * 100}%`);
const controlsVisible = computed(() => !playing.value || hovering.value);

function toggle() {
  const el = video.value;
  if (!el) return;
  if (el.paused) void el.play();
  else el.pause();
}
function onMeta() {
  const d = video.value?.duration ?? 0;
  duration.value = Number.isFinite(d) ? d : 0;
}

// ---- seeking (pointer drag + click + arrow keys) ----------------------------
const track = ref<HTMLElement>();
let seeking = false;
function seekToClientX(clientX: number) {
  const el = video.value;
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
  const el = video.value;
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

function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void container.value?.requestFullscreen?.();
}

onBeforeUnmount(() => video.value?.pause());
</script>

<template>
  <div
    ref="container"
    class="group relative max-w-[360px] overflow-hidden rounded-lg bg-black"
    @mouseenter="hovering = true"
    @mouseleave="hovering = false"
  >
    <video
      ref="video"
      :src="src"
      autoplay
      playsinline
      :aria-label="name"
      class="block max-h-[420px] w-full"
      @click="toggle"
      @play="playing = true"
      @pause="playing = false"
      @ended="playing = false"
      @timeupdate="current = video?.currentTime ?? 0"
      @loadedmetadata="onMeta"
      @durationchange="onMeta"
    />

    <!-- Centered play button while paused. -->
    <button
      v-if="!playing"
      type="button"
      aria-label="Play"
      class="absolute inset-0 flex items-center justify-center"
      @click="toggle"
    >
      <span class="flex h-14 w-14 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition group-hover:bg-black/70">
        <IconPlay class="h-7 w-7 translate-x-0.5" />
      </span>
    </button>

    <!-- Bottom control bar: visible while hovering or paused. -->
    <div
      class="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/70 to-transparent px-2.5 pb-2 pt-6 text-white transition-opacity"
      :class="controlsVisible ? 'opacity-100' : 'opacity-0'"
    >
      <button type="button" :aria-label="playing ? 'Pause' : 'Play'" class="shrink-0" @click="toggle">
        <IconPause v-if="playing" class="h-5 w-5" />
        <IconPlay v-else class="h-5 w-5" />
      </button>
      <span class="shrink-0 text-[11px] tabular-nums">{{ fmt(current) }}</span>
      <div
        ref="track"
        role="slider"
        tabindex="0"
        aria-label="Seek"
        :aria-valuemin="0"
        :aria-valuemax="Math.round(duration)"
        :aria-valuenow="Math.round(current)"
        class="group/seek relative h-1.5 grow cursor-pointer touch-none rounded-full bg-white/30"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @keydown="onKey"
      >
        <div class="absolute inset-y-0 left-0 rounded-full bg-white" :style="{ width: pct }" />
        <div
          class="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white opacity-0 transition-opacity group-hover/seek:opacity-100"
          :style="{ left: pct }"
        />
      </div>
      <span class="shrink-0 text-[11px] tabular-nums">{{ fmt(duration) }}</span>
      <button type="button" aria-label="Fullscreen" class="shrink-0" @click="toggleFullscreen">
        <IconMaximize class="h-4 w-4" />
      </button>
    </div>
  </div>
</template>
