<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import ConversationView from '../components/ConversationView.vue';
import ChatSidebar from '../components/ChatSidebar.vue';
import NoteEditor from '../components/NoteEditor.vue';
import EmojiText from '../components/EmojiText.vue';
import ManageMembersDrawer from '../components/ManageMembersDrawer.vue';
import { conversationTitle } from '../lib/convName';
import { useChatStore } from '../stores/chat';
import { useNotesStore } from '../stores/notes';
import { useOrgStore } from '../stores/organization';
import { useSessionStore } from '../stores/session';
import IconUsers from '~icons/mynaui/users';
import IconHash from '~icons/mynaui/hash';
import IconNote from '~icons/mynaui/file-text';
import IconX from '~icons/mynaui/x';

const route = useRoute();
const router = useRouter();
const chat = useChatStore();
const notes = useNotesStore();
const org = useOrgStore();
const session = useSessionStore();

// Load personal organization + notes so the sidebar's Pinned section and the
// note overlay work even when landing directly in a chat (idempotent).
watch(
  () => session.unlocked,
  async (u) => {
    if (!u) return;
    void org.load();
    if (!notes.loaded) await notes.loadFromCache();
    void notes.sync();
  },
  { immediate: true },
);

// A pinned note opened over the chat window (close ✕ in its header).
const openNoteId = ref<string | null>(null);
const openNote = computed(() => (openNoteId.value ? (notes.notes.get(openNoteId.value) ?? null) : null));

const convId = computed(() => String(route.params.id));

// The channel currently being viewed comes from the route, so a refresh keeps
// you in the channel. The general channel is the bare `/chat/:id` (no segment);
// an extra channel is `/chat/:id/:channelId`.
const activeChannelId = computed(() => {
  const ch = route.params.channelId;
  return typeof ch === 'string' && ch ? ch : convId.value;
});
function selectChannel(channelId: string) {
  void router.push(channelId === convId.value ? `/chat/${convId.value}` : `/chat/${convId.value}/${channelId}`);
}
const activeChannel = computed(() =>
  conversation.value?.channels?.find((c) => c.id === activeChannelId.value),
);
// Switching conversations closes any open note overlay.
watch(convId, () => {
  openNoteId.value = null;
});

// The conversation name shown in the shared header above both panes. This header
// is the visible one (the inner ConversationView is rendered with `hide-header`),
// so group member-management lives here.
const conversation = computed(() => chat.conversations.find((c) => c.id === convId.value));
const parentTitle = computed(() =>
  conversation.value ? conversationTitle(conversation.value, session.user?.id) : 'Conversation',
);
const isGroup = computed(() => conversation.value?.kind === 'group');

// If the route points at a channel that doesn't exist (deleted / stale link),
// fall back to the general channel once the conversation's channels are known.
watch(
  [() => conversation.value?.channels, activeChannelId],
  ([channels]) => {
    if (channels && activeChannelId.value !== convId.value && !channels.some((c) => c.id === activeChannelId.value)) {
      void router.replace(`/chat/${convId.value}`);
    }
  },
  { immediate: true },
);
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
        @select="selectChannel($event)"
        @open-note="openNoteId = $event"
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
          <IconHash class="h-3.5 w-3.5 shrink-0" /><EmojiText :text="activeChannel.name" />
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

      <!-- A pinned note opened over the chat window (rules, character sheets,
           co-working docs, …). Closes with the ✕; edits save to your notes. -->
      <div v-if="openNote" class="absolute inset-0 z-modal flex flex-col bg-white dark:bg-zinc-900">
        <div class="flex shrink-0 items-center gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
          <IconNote class="h-4 w-4 shrink-0 text-zinc-400" />
          <p class="min-w-0 grow truncate font-medium"><EmojiText :text="openNote.payload.title || 'Untitled'" /></p>
          <button
            class="ml-auto flex shrink-0 items-center rounded-lg p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            title="Close note"
            @click="openNoteId = null"
          >
            <IconX class="h-5 w-5" />
          </button>
        </div>
        <div class="min-h-0 grow"><NoteEditor :note="openNote" @deleted="openNoteId = null" /></div>
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
