<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import ConversationView from '../components/ConversationView.vue';
import { useChatStore } from '../stores/chat';

const route = useRoute();
const chat = useChatStore();

const convId = computed(() => String(route.params.id));
// The thread shown in the side panel (a thread is itself a conversation id).
const activeThread = ref<string | null>(null);

async function onOpenThread(seq: number) {
  try {
    activeThread.value = await chat.openThread(convId.value, seq);
  } catch {
    /* member missing a public key, etc. */
  }
}

// Switching the main conversation closes any open thread panel.
watch(convId, () => {
  activeThread.value = null;
});

// --- Responsive split (measured on the chat region, not the viewport, so the
// sidebar state is accounted for) + a draggable thread width. ---
const region = ref<HTMLElement>();
const regionWidth = ref(0);
let ro: ResizeObserver | null = null;
onMounted(() => {
  ro = new ResizeObserver((entries) => {
    regionWidth.value = entries[0]!.contentRect.width;
  });
  if (region.value) ro.observe(region.value);
});
onBeforeUnmount(() => ro?.disconnect());

// Wide enough to split side-by-side; otherwise the thread slides over the chat.
const WIDE_MIN = 768;
const isWide = computed(() => regionWidth.value >= WIDE_MIN);

const MIN_PANEL = 320;
const MIN_CHAT = 360;
function clampWidth(w: number): number {
  const max = Math.max(MIN_PANEL, regionWidth.value - MIN_CHAT);
  return Math.min(max, Math.max(MIN_PANEL, w));
}

// User-set width (px); null until dragged → defaults to half the chat region.
const panelWidth = ref<number | null>(null);
const displayWidth = computed(() => clampWidth(panelWidth.value ?? regionWidth.value / 2));

const dragging = ref(false);
function onDrag(e: PointerEvent) {
  if (!region.value) return;
  panelWidth.value = clampWidth(region.value.getBoundingClientRect().right - e.clientX);
}
function stopDrag() {
  dragging.value = false;
  document.body.style.userSelect = '';
  window.removeEventListener('pointermove', onDrag);
  window.removeEventListener('pointerup', stopDrag);
}
function startDrag() {
  dragging.value = true;
  document.body.style.userSelect = 'none';
  window.addEventListener('pointermove', onDrag);
  window.addEventListener('pointerup', stopDrag);
}
onBeforeUnmount(stopDrag);
</script>

<template>
  <AppLayout>
    <div ref="region" class="relative flex h-full">
      <div class="min-w-0 flex-1">
        <ConversationView :conv-id="convId" @open-thread="onOpenThread" />
      </div>

      <template v-if="activeThread">
        <!-- Drag handle = the separating line (wide mode only). -->
        <div
          v-if="isWide"
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize"
          class="w-1 shrink-0 cursor-col-resize bg-zinc-200 transition-colors hover:bg-blue-400 dark:bg-zinc-800 dark:hover:bg-blue-500"
          :class="{ '!bg-blue-400 dark:!bg-blue-500': dragging }"
          @pointerdown.prevent="startDrag"
        />
        <!-- Wide: sized flex child (defaults to half). Narrow: full-cover overlay. -->
        <div
          :class="isWide ? 'shrink-0' : 'absolute inset-0 z-20 bg-white dark:bg-zinc-900'"
          :style="isWide ? { width: `${displayWidth}px` } : undefined"
        >
          <ConversationView
            :conv-id="activeThread"
            is-thread-panel
            @open-thread="onOpenThread"
            @close="activeThread = null"
          />
        </div>
      </template>
    </div>
  </AppLayout>
</template>
