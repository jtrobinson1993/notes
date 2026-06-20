<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppLayout from '../components/AppLayout.vue';
import ConversationView from '../components/ConversationView.vue';
import ChatSidebar from '../components/ChatSidebar.vue';
import NoteEditor from '../components/NoteEditor.vue';
import EmojiText from '../components/EmojiText.vue';
import ManageMembersDrawer from '../components/ManageMembersDrawer.vue';
import AvatarCropper from '../components/AvatarCropper.vue';
import { conversationTitle } from '../lib/convName';
import { MAX_AVATAR_INPUT_BYTES } from '../lib/avatar';
import { useChatStore } from '../stores/chat';
import { useNotesStore } from '../stores/notes';
import { useOrgStore } from '../stores/organization';
import { useSessionStore } from '../stores/session';
import { useVoiceStore } from '../stores/voice';
import IconUsers from '~icons/mynaui/users';
import IconHash from '~icons/mynaui/hash';
import IconPhone from '~icons/mynaui/telephone-call';
import IconChevronLeft from '~icons/mynaui/chevron-left';
import { chatPane, homeOpen, isMobile, showChannels, showMessages } from '../lib/mobileNav';

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
  openNoteId.value = null; // selecting a channel (incl. DM "#chat") exits a note
  showMessages(); // mobile: a channel opens its messages full-screen
  void router.push(channelId === convId.value ? `/chat/${convId.value}` : `/chat/${convId.value}/${channelId}`);
}
const activeChannel = computed(() =>
  conversation.value?.channels?.find((c) => c.id === activeChannelId.value),
);
// Switching conversations closes any open note overlay. On mobile, switching to
// a different chat resets to its channel list (tap a channel to view messages).
watch(convId, () => {
  openNoteId.value = null;
  showChannels();
});

// The conversation name shown in the shared header above both panes. This header
// is the visible one (the inner ConversationView is rendered with `hide-header`),
// so group member-management lives here.
const conversation = computed(() => chat.conversations.find((c) => c.id === convId.value));
const parentTitle = computed(() =>
  conversation.value ? conversationTitle(conversation.value, session.user?.id) : 'Conversation',
);
const isGroup = computed(() => conversation.value?.kind === 'group');

// Group name/icon editing (owner/admin) lives in this (visible) header.
const voice = useVoiceStore();
const canEditGroup = computed(() => isGroup.value && (conversation.value?.myRole === 'owner' || conversation.value?.myRole === 'admin'));
const groupIcon = computed(() => chat.groupIconUrl(convId.value));

const editingName = ref(false);
const nameDraft = ref('');
const nameInput = ref<HTMLInputElement | null>(null);
// A hidden mirror of the draft text, used to size the input to its content. The
// rendered width is clamped by `max-w-full` on the input so it can never push
// the header's call/members buttons out of view.
const NAME_PLACEHOLDER = 'Group name';
const nameSizer = ref<HTMLSpanElement | null>(null);
const nameWidth = ref(0);
function measureName(): void {
  void nextTick(() => {
    if (nameSizer.value) nameWidth.value = nameSizer.value.offsetWidth;
  });
}
watch(nameDraft, measureName);
function startEditName(): void {
  if (!canEditGroup.value) return;
  nameDraft.value = conversation.value?.name ?? '';
  editingName.value = true;
  measureName();
  void nextTick(() => nameInput.value?.focus());
}
// Esc cancels without saving; blur (clicking elsewhere) saves and exits.
function cancelEditName(): void {
  editingName.value = false;
}
async function saveName(): Promise<void> {
  if (!editingName.value) return;
  editingName.value = false;
  const next = nameDraft.value.trim();
  if (next !== (conversation.value?.name ?? '')) await chat.renameGroup(convId.value, next);
}

const iconInput = ref<HTMLInputElement | null>(null);
const cropFile = ref<File | null>(null);
const cropOpen = ref(false);
function pickIcon(e: Event): void {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file || file.size > MAX_AVATAR_INPUT_BYTES) return;
  cropFile.value = file;
  cropOpen.value = true;
  (e.target as HTMLInputElement).value = '';
}
async function onIconCropped(dataUrl: string): Promise<void> {
  await chat.setGroupIcon(convId.value, dataUrl);
}

// Start a voice call on this conversation (1:1 or group).
const canCall = computed(() => !!conversation.value && voice.activeRoomId !== convId.value);
function startCall(): void {
  void voice.startCall(convId.value, parentTitle.value);
}

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
    <!-- On mobile the home (AppSidebar) shows alone; this page hides until you
         open a chat. On desktop all panes render side-by-side. -->
    <div class="h-full" :class="isMobile && homeOpen ? 'hidden' : 'flex'">
      <!-- Sidebar: channels + pins for groups, pins only for DMs (threads: none).
           Mobile: full-screen "channels" pane, hidden while viewing messages. -->
      <ChatSidebar
        v-if="conversation && conversation.kind !== 'thread'"
        :conversation="conversation"
        :active-channel-id="activeChannelId"
        :open-note-id="openNoteId"
        :mobile="isMobile"
        :class="isMobile && chatPane !== 'channels' ? 'hidden' : ''"
        @select="selectChannel($event)"
        @open-note="(id) => { openNoteId = id; showMessages(); }"
      />

      <div
        class="h-full min-w-0 grow flex-col"
        :class="isMobile && chatPane !== 'messages' ? 'hidden' : 'flex'"
      >
      <!-- Shared conversation header, above both the chat and the thread panel. -->
      <header class="flex shrink-0 items-center gap-2 border-b border-zinc-200 px-2 py-2 dark:border-zinc-800">
        <!-- Mobile: back to the channel list (this view covers the whole screen). -->
        <button
          v-if="isMobile"
          type="button"
          class="-ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          aria-label="Back to channels"
          @click="showChannels()"
        >
          <IconChevronLeft class="h-5 w-5" />
        </button>
        <!-- Conversation icon. Owners/admins can click it to set a group icon. -->
        <button
          type="button"
          class="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-200 text-sm font-medium text-zinc-600 dark:bg-zinc-700 dark:text-zinc-200"
          :class="canEditGroup ? 'cursor-pointer hover:opacity-80' : 'cursor-default'"
          :disabled="!canEditGroup"
          :title="canEditGroup ? 'Change group icon' : parentTitle"
          @click="iconInput?.click()"
        >
          <img v-if="groupIcon" :src="groupIcon" alt="" class="h-full w-full object-cover" />
          <template v-else>{{ (parentTitle.trim()[0] ?? '?').toUpperCase() }}</template>
        </button>
        <input v-if="canEditGroup" ref="iconInput" type="file" accept="image/*" class="hidden" @change="pickIcon" />
        <!-- Name + active-channel slot: shrinkable so a long name (or its editor)
             can never push the call/members buttons out of the header. -->
        <div class="flex min-w-0 flex-1 items-center gap-2">
          <!-- Conversation name. Owners/admins click to rename a group inline. -->
          <template v-if="editingName">
            <!-- Hidden mirror that sizes the input to its content. -->
            <span ref="nameSizer" aria-hidden="true" class="pointer-events-none invisible absolute whitespace-pre font-semibold">{{ nameDraft || NAME_PLACEHOLDER }}</span>
            <input
              ref="nameInput"
              v-model="nameDraft"
              type="text"
              :maxlength="60"
              :style="{ width: `${nameWidth + 2}px` }"
              class="min-w-0 max-w-full border-x-0 border-t-0 border-b border-zinc-300 bg-transparent px-0 py-0 font-semibold focus:border-blue-500 focus:outline-none focus:ring-0 dark:border-zinc-600"
              :placeholder="NAME_PLACEHOLDER"
              @keydown.enter.prevent="saveName"
              @keydown.esc.prevent="cancelEditName"
              @blur="saveName"
            />
          </template>
          <p
            v-else
            class="min-w-0 truncate font-semibold"
            :class="canEditGroup ? 'cursor-pointer rounded px-1 hover:bg-zinc-100 dark:hover:bg-zinc-800' : ''"
            :title="canEditGroup ? 'Rename group' : ''"
            @click="startEditName"
          >{{ parentTitle }}</p>
          <!-- Active channel name (groups). -->
          <span
            v-if="isGroup && activeChannel"
            class="flex min-w-0 items-center gap-0.5 truncate text-sm text-zinc-400"
          >
            <IconHash class="h-3.5 w-3.5 shrink-0" /><EmojiText :text="activeChannel.name" />
          </span>
        </div>
        <div class="ml-auto flex items-center gap-1">
          <button
            v-if="canCall"
            class="flex items-center rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-green-600 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-green-400"
            title="Start a voice call"
            @click="startCall"
          >
            <IconPhone class="h-4.5 w-4.5" />
          </button>
          <!-- Group member management (groups only). -->
          <button
            v-if="isGroup && conversation"
            class="flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            title="Members"
            @click="showMembers = true"
          >
            <IconUsers class="h-4 w-4" />
            <span>{{ conversation.members.length }}</span>
          </button>
        </div>
      </header>
      <AvatarCropper v-if="canEditGroup" v-model:open="cropOpen" :file="cropFile" @cropped="onIconCropped" />
      <ManageMembersDrawer v-if="conversation && isGroup" v-model:open="showMembers" :conversation="conversation" />

      <div ref="region" class="relative flex min-h-0 flex-1">
        <div class="min-w-0 flex-1">
          <ConversationView :conv-id="convId" :channel-id="activeChannelId" hide-header @open-thread="onOpenThread" />
        </div>

      <!-- A pinned note opened over the chat window (rules, character sheets,
           co-working docs, …). The editor's own header carries the close ✕
           (next to its kebab); edits save to your notes. -->
      <div v-if="openNote" class="absolute inset-0 z-modal flex flex-col bg-zinc-50 dark:bg-zinc-950">
        <NoteEditor :note="openNote" closable @deleted="openNoteId = null" @close="openNoteId = null" />
      </div>

      <template v-if="activeThread">
        <!-- Drag handle: a wide grab area with a 1px line (wide mode only). -->
        <div
          v-if="isWide"
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize"
          class="group/th relative w-2 shrink-0 cursor-col-resize"
          @pointerdown.prevent="startDrag"
        >
          <div
            class="mx-auto h-full w-px bg-zinc-200 transition-colors group-hover/th:bg-blue-400 dark:bg-zinc-800"
            :class="{ '!bg-blue-400 dark:!bg-blue-500': dragging }"
          ></div>
        </div>
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
