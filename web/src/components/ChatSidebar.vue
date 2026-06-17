<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import ChannelModal from './ChannelModal.vue';
import { useChatStore } from '../stores/chat';
import { canManageMembers, type ChannelInfo, type ChannelType, type Conversation } from '@notes/shared';
import IconHash from '~icons/mynaui/hash';
import IconVolume from '~icons/mynaui/volume-high';
import IconPanelLeft from '~icons/mynaui/panel-left';
import IconPlus from '~icons/mynaui/plus';
import IconPencil from '~icons/mynaui/pencil';
import IconTrash from '~icons/mynaui/trash';
import IconEdit from '~icons/mynaui/edit-one';
import IconChevronUp from '~icons/mynaui/chevron-up';
import IconChevronDown from '~icons/mynaui/chevron-down';
import IconCheck from '~icons/mynaui/check';

// The per-conversation channel sidebar (groups). Collapsible with a persisted
// open/closed state; an edit mode at the bottom turns the list into
// rename/reorder/delete controls and exposes channel creation.
const props = defineProps<{ conversation: Conversation; activeChannelId: string }>();
const emit = defineEmits<{ select: [channelId: string] }>();
const chat = useChatStore();

// Open/closed state persists across sessions (one toggle for the chat sidebar).
const STORAGE_KEY = 'chat:channels:open';
const open = ref(localStorage.getItem(STORAGE_KEY) !== '0');
watch(open, (o) => localStorage.setItem(STORAGE_KEY, o ? '1' : '0'));
function toggle() {
  open.value = !open.value;
  if (!open.value) editing.value = false;
}

const canManage = computed(() => canManageMembers(props.conversation.myRole));
const channels = computed<ChannelInfo[]>(() => [...(props.conversation.channels ?? [])].sort((a, b) => a.position - b.position));
const extra = computed(() => channels.value.filter((c) => !c.isDefault));

const editing = ref(false);
const busy = ref(false);

function unread(ch: ChannelInfo): number {
  return Math.max(0, ch.lastSeq - ch.lastReadSeq);
}
function select(ch: ChannelInfo) {
  if (ch.type === 'voice') return; // voice channels have no text stream yet (v6)
  emit('select', ch.id);
}

// ---- Create / rename ----
const modalOpen = ref(false);
const modalMode = ref<'create' | 'rename'>('create');
const renameTarget = ref<ChannelInfo | null>(null);

function openCreate() {
  modalMode.value = 'create';
  renameTarget.value = null;
  modalOpen.value = true;
}
function openRename(ch: ChannelInfo) {
  modalMode.value = 'rename';
  renameTarget.value = ch;
  modalOpen.value = true;
}
async function onModalSubmit(payload: { name: string; type: ChannelType }) {
  busy.value = true;
  try {
    if (modalMode.value === 'create') {
      const id = await chat.createChannel(props.conversation.id, payload.name, payload.type);
      modalOpen.value = false;
      if (payload.type === 'text') emit('select', id);
    } else if (renameTarget.value) {
      await chat.renameChannel(props.conversation.id, renameTarget.value.id, payload.name);
      modalOpen.value = false;
    }
  } finally {
    busy.value = false;
  }
}

// ---- Reorder (up/down) + delete ----
async function move(ch: ChannelInfo, dir: -1 | 1) {
  const ids = extra.value.map((c) => c.id);
  const i = ids.indexOf(ch.id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  busy.value = true;
  try {
    await chat.reorderChannels(props.conversation.id, ids);
  } finally {
    busy.value = false;
  }
}
async function remove(ch: ChannelInfo) {
  if (!confirm(`Delete #${ch.name}? Its messages will be permanently removed.`)) return;
  busy.value = true;
  try {
    if (props.activeChannelId === ch.id) emit('select', props.conversation.id);
    await chat.deleteChannel(props.conversation.id, ch.id);
  } finally {
    busy.value = false;
  }
}

// If the active channel disappears (deleted elsewhere), fall back to general.
watch(
  () => channels.value.map((c) => c.id).join(','),
  () => {
    if (!channels.value.some((c) => c.id === props.activeChannelId)) emit('select', props.conversation.id);
  },
);
</script>

<template>
  <!-- Collapsed: a slim rail with just the open toggle. -->
  <aside
    v-if="!open"
    class="z-nav flex w-12 shrink-0 flex-col items-center border-r border-zinc-200 bg-zinc-50 py-2 dark:border-zinc-800 dark:bg-zinc-950"
  >
    <button
      class="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-200/70 dark:text-zinc-400 dark:hover:bg-zinc-800"
      aria-label="Show channels"
      title="Show channels"
      @click="toggle"
    >
      <IconPanelLeft class="h-5 w-5" />
    </button>
  </aside>

  <!-- Open: the channel list. -->
  <aside
    v-else
    class="z-nav flex w-56 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950"
  >
    <header class="flex items-center gap-1 px-2 py-2">
      <button
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-200/70 dark:text-zinc-400 dark:hover:bg-zinc-800"
        aria-label="Hide channels"
        title="Hide channels"
        @click="toggle"
      >
        <IconPanelLeft class="h-5 w-5" />
      </button>
      <span class="min-w-0 grow truncate px-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">Channels</span>
      <button
        v-if="canManage"
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-200/70 dark:text-zinc-400 dark:hover:bg-zinc-800"
        aria-label="Create channel"
        title="Create channel"
        @click="openCreate"
      >
        <IconPlus class="h-4 w-4" />
      </button>
    </header>

    <ul class="min-h-0 grow space-y-0.5 overflow-y-auto px-2 pb-2">
      <li v-for="ch in channels" :key="ch.id" class="flex items-center gap-1">
        <button
          class="flex min-w-0 grow items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm"
          :class="[
            ch.id === activeChannelId ? 'bg-zinc-200 font-medium dark:bg-zinc-800' : 'text-zinc-600 hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-800/60',
            ch.type === 'voice' ? 'cursor-default opacity-70' : '',
          ]"
          :aria-current="ch.id === activeChannelId ? 'true' : undefined"
          @click="select(ch)"
        >
          <IconVolume v-if="ch.type === 'voice'" class="h-4 w-4 shrink-0 opacity-60" />
          <IconHash v-else class="h-4 w-4 shrink-0 opacity-60" />
          <span class="min-w-0 grow truncate">{{ ch.name }}</span>
          <span
            v-if="unread(ch) > 0 && ch.id !== activeChannelId"
            class="ml-1 shrink-0 rounded-full bg-blue-600 px-1.5 text-[10px] font-semibold leading-4 text-white"
          >{{ unread(ch) > 99 ? '99+' : unread(ch) }}</span>
        </button>

        <!-- Edit-mode controls for an extra channel (general is fixed). -->
        <template v-if="editing && !ch.isDefault">
          <button class="rounded p-1 text-zinc-400 hover:text-zinc-700 disabled:opacity-30 dark:hover:text-zinc-200" title="Move up" :disabled="busy" @click="move(ch, -1)"><IconChevronUp class="h-3.5 w-3.5" /></button>
          <button class="rounded p-1 text-zinc-400 hover:text-zinc-700 disabled:opacity-30 dark:hover:text-zinc-200" title="Move down" :disabled="busy" @click="move(ch, 1)"><IconChevronDown class="h-3.5 w-3.5" /></button>
          <button class="rounded p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" title="Rename" :disabled="busy" @click="openRename(ch)"><IconPencil class="h-3.5 w-3.5" /></button>
          <button class="rounded p-1 text-zinc-400 hover:text-red-600 dark:hover:text-red-400" title="Delete" :disabled="busy" @click="remove(ch)"><IconTrash class="h-3.5 w-3.5" /></button>
        </template>
      </li>
    </ul>

    <!-- Bottom edit toggle (managers only). -->
    <footer v-if="canManage" class="border-t border-zinc-200 p-2 dark:border-zinc-800">
      <button
        class="flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium"
        :class="editing ? 'bg-blue-600 text-white hover:bg-blue-700' : 'text-zinc-500 hover:bg-zinc-200/70 dark:text-zinc-400 dark:hover:bg-zinc-800'"
        @click="editing = !editing"
      >
        <component :is="editing ? IconCheck : IconEdit" class="h-4 w-4" />
        {{ editing ? 'Done' : 'Edit channels' }}
      </button>
    </footer>

    <ChannelModal
      v-model:open="modalOpen"
      :mode="modalMode"
      :initial-name="renameTarget?.name"
      :busy="busy"
      @submit="onModalSubmit"
    />
  </aside>
</template>
