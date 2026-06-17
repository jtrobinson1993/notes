<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import ConversationView from '../components/ConversationView.vue';
import ChatSidebar from '../components/ChatSidebar.vue';
import ManageMembersDrawer from '../components/ManageMembersDrawer.vue';
import { conversationTitle } from '../lib/convName';
import { useChatStore } from '../stores/chat';
import { useSessionStore } from '../stores/session';
import IconUsers from '~icons/mynaui/users';
import IconHash from '~icons/mynaui/hash';

const route = useRoute();
const chat = useChatStore();
const session = useSessionStore();

const convId = computed(() => String(route.params.id));

// The channel currently being viewed. Defaults to the general channel (whose id
// is the conversation id). Reset when switching conversations.
const activeChannelId = ref<string>(convId.value);
watch(convId, (id) => {
  activeChannelId.value = id;
});
const activeChannel = computed(() =>
  conversation.value?.channels?.find((c) => c.id === activeChannelId.value),
);

// The conversation name shown in the shared header above both panes. This header
// is the visible one (the inner ConversationView is rendered with `hide-header`),
// so group member-management lives here.
const conversation = computed(() => chat.conversations.find((c) => c.id === convId.value));
const parentTitle = computed(() =>
  conversation.value ? conversationTitle(conversation.value, session.user?.id) : 'Conversation',
);
const isGroup = computed(() => conversation.value?.kind === 'group');
const showMembers = ref(false);
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
    <div class="flex h-full">
      <!-- Sidebar: channels + pins for groups, pins only for DMs (threads: none). -->
      <ChatSidebar
        v-if="conversation && conversation.kind !== 'thread'"
        :conversation="conversation"
        :active-channel-id="activeChannelId"
        @select="activeChannelId = $event"
      />

      <div class="flex h-full min-w-0 grow flex-col">
      <!-- Shared conversation header, above both the chat and the thread panel. -->
      <header class="flex shrink-0 items-center gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-sm font-medium text-zinc-600 dark:bg-zinc-700 dark:text-zinc-200">
          {{ (parentTitle.trim()[0] ?? '?').toUpperCase() }}
        </span>
        <p class="font-semibold">{{ parentTitle }}</p>
        <!-- Active channel name (groups). -->
        <span
          v-if="isGroup && activeChannel"
          class="flex min-w-0 items-center gap-0.5 truncate text-sm text-zinc-400"
        >
          <IconHash class="h-3.5 w-3.5 shrink-0" />{{ activeChannel.name }}
        </span>
        <!-- Group member management (groups only). -->
        <button
          v-if="isGroup && conversation"
          class="ml-auto flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          title="Members"
          @click="showMembers = true"
        >
          <IconUsers class="h-4 w-4" />
          <span>{{ conversation.members.length }}</span>
        </button>
      </header>
      <ManageMembersDrawer v-if="conversation && isGroup" v-model:open="showMembers" :conversation="conversation" />

      <div ref="region" class="relative flex min-h-0 flex-1">
        <div class="min-w-0 flex-1">
          <ConversationView :conv-id="convId" :channel-id="activeChannelId" hide-header @open-thread="onOpenThread" />
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
          :class="isWide ? 'shrink-0' : 'absolute inset-0 z-nav bg-white dark:bg-zinc-900'"
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
      </div>
    </div>
  </AppLayout>
</template>
