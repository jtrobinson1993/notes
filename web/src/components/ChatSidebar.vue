<script setup lang="ts">
import { computed, ref } from 'vue';
import ChannelModal from './ChannelModal.vue';
import PinPickerModal from './PinPickerModal.vue';
import EmojiText from './EmojiText.vue';
import ResizeHandle from './ResizeHandle.vue';
import { useResizable } from '../lib/useResizable';
import { useChatStore } from '../stores/chat';
import { useNotesStore } from '../stores/notes';
import { useOrgStore, chKey, noteItemKey } from '../stores/organization';
import { isCollapsed, toggleCollapsed } from '../lib/folderCollapse';
import { canManageMembers, type ChannelInfo, type ChannelType, type Conversation } from '@notes/shared';
import IconHash from '~icons/mynaui/hash';
import IconVolume from '~icons/mynaui/volume-high';
import IconPanelLeft from '~icons/mynaui/panel-left';
import IconPlus from '~icons/mynaui/plus';
import IconPencil from '~icons/mynaui/pencil';
import IconTrash from '~icons/mynaui/trash';
import IconFolderMinus from '~icons/mynaui/folder-minus';
import IconFolderPlus from '~icons/mynaui/folder-plus';
import IconNote from '~icons/mynaui/file-text';
import IconPin from '~icons/mynaui/pin';
import IconX from '~icons/mynaui/x';

// The per-conversation sidebar as a unified tree: chat folders (a namespace
// distinct from note folders, personal like pins) group channels AND pinned
// notes. Channel create/rename/delete are server-side (managers); the folder
// arrangement, ordering, and pins are personal to each member.
const props = defineProps<{ conversation: Conversation; activeChannelId: string; openNoteId?: string | null }>();
const emit = defineEmits<{ select: [channelId: string]; openNote: [noteId: string] }>();

// A channel is "active" only when no note overlay is open; the open note row
// highlights instead.
function channelActive(channelId: string): boolean {
  return !props.openNoteId && channelId === props.activeChannelId;
}
function noteActive(noteId: string): boolean {
  return props.openNoteId === noteId;
}
const chat = useChatStore();
const notes = useNotesStore();
const org = useOrgStore();

const convId = computed(() => props.conversation.id);
const isGroup = computed(() => props.conversation.kind === 'group');
const canManage = computed(() => canManageMembers(props.conversation.myRole));

const STORAGE_KEY = 'chat:channels:open';
const open = ref(localStorage.getItem(STORAGE_KEY) !== '0');
const { width: sidebarWidth, dragging: resizing, start: startResize } = useResizable('chat:sidebar:w', 224, 180, 420);
function toggleOpen() {
  open.value = !open.value;
  localStorage.setItem(STORAGE_KEY, open.value ? '1' : '0');
}

// ---- Items (channels + pinned notes) ----
type Item =
  | { key: string; kind: 'channel'; channel: ChannelInfo }
  | { key: string; kind: 'note'; noteId: string; title: string };

const allItems = computed<Item[]>(() => {
  // DMs have only the general channel (the chat itself) — don't surface it as a
  // row; their sidebar is pins-only. Groups list all channels.
  const chans: Item[] = isGroup.value
    ? (props.conversation.channels ?? []).map((ch) => ({ key: chKey(ch.id), kind: 'channel', channel: ch }))
    : [];
  const notePins: Item[] = org
    .pinsFor(convId.value)
    .filter((p) => p.kind === 'note')
    .map((p) => ({ key: noteItemKey(p.id), kind: 'note', noteId: p.id, title: notes.notes.get(p.id)?.payload.title || 'Untitled' }));
  return [...chans, ...notePins];
});
const itemByKey = computed(() => new Map(allItems.value.map((i) => [i.key, i])));
function itemsInFolder(folderId: string | null): Item[] {
  const keys = allItems.value.filter((i) => org.chatItemFolderOf(convId.value, i.key) === folderId).map((i) => i.key);
  return org.orderedChatItems(convId.value, folderId, keys).map((k) => itemByKey.value.get(k)!).filter(Boolean);
}

interface Row {
  key: string;
  type: 'folder' | 'item';
  depth: number;
  folder?: { id: string; name: string };
  item?: Item;
}
const treeRows = computed<Row[]>(() => {
  const out: Row[] = [];
  for (const it of itemsInFolder(null)) out.push({ key: `i:${it.key}`, type: 'item', depth: 0, item: it });
  const walk = (parentId: string | null, depth: number) => {
    for (const f of org.chatChildFolders(convId.value, parentId)) {
      out.push({ key: `f:${f.id}`, type: 'folder', depth, folder: f });
      if (isCollapsed(f.id)) continue;
      for (const it of itemsInFolder(f.id)) out.push({ key: `i:${it.key}`, type: 'item', depth: depth + 1, item: it });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
});

function depthPad(depth: number): string {
  return `${depth * 14 + 8}px`;
}
function unread(ch: ChannelInfo): number {
  return Math.max(0, ch.lastSeq - ch.lastReadSeq);
}
function selectItem(it: Item) {
  if (it.kind === 'note') emit('openNote', it.noteId);
  else if (it.channel.type !== 'voice') emit('select', it.channel.id); // voice has no text stream yet
}

// ---- Channel create / rename / delete (server; managers) ----
const channelModalOpen = ref(false);
const channelMode = ref<'create' | 'rename'>('create');
const renameChannelTarget = ref<ChannelInfo | null>(null);
const busy = ref(false);
function openChannelCreate() {
  channelMode.value = 'create';
  renameChannelTarget.value = null;
  channelModalOpen.value = true;
}
function openChannelRename(ch: ChannelInfo) {
  channelMode.value = 'rename';
  renameChannelTarget.value = ch;
  channelModalOpen.value = true;
}
async function onChannelSubmit(payload: { name: string; type: ChannelType }) {
  busy.value = true;
  try {
    if (channelMode.value === 'create') {
      const id = await chat.createChannel(convId.value, payload.name, payload.type);
      channelModalOpen.value = false;
      if (payload.type === 'text') emit('select', id);
    } else if (renameChannelTarget.value) {
      await chat.renameChannel(convId.value, renameChannelTarget.value.id, payload.name);
      channelModalOpen.value = false;
    }
  } finally {
    busy.value = false;
  }
}
async function deleteChannel(ch: ChannelInfo) {
  if (!confirm(`Delete #${ch.name}? Its messages will be permanently removed.`)) return;
  busy.value = true;
  try {
    if (props.activeChannelId === ch.id) emit('select', convId.value);
    await chat.deleteChannel(convId.value, ch.id);
  } finally {
    busy.value = false;
  }
}

// ---- Chat folders + pins (personal) ----
const pinPickerOpen = ref(false);
function createFolder() {
  const name = window.prompt('New folder name')?.trim();
  if (name) org.createChatFolder(convId.value, name);
}
function createSubfolder(parentId: string) {
  const name = window.prompt('New subfolder name')?.trim();
  if (name) org.createChatFolder(convId.value, name, parentId);
}
function renameFolder(id: string, current: string) {
  const name = window.prompt('Rename folder', current)?.trim();
  if (name) org.renameChatFolder(convId.value, id, name);
}
function deleteFolder(id: string, name: string) {
  if (!window.confirm(`Delete folder "${name}"? Its channels and notes move out; nothing is deleted.`)) return;
  org.deleteChatFolder(convId.value, id);
}
function unpinNote(noteId: string) {
  org.unpin(convId.value, 'note', noteId);
}

// ---- Drag & drop (personal arrangement) ----
const draggingItem = ref<string | null>(null);
const draggingFolder = ref<string | null>(null);
// The row currently dragged over: `into` = drop inside a folder (ring); otherwise
// an insertion line before (`after:false`) or after (`after:true`) the row, based
// on which half the cursor is over. Absolutely positioned, so no layout shift.
const dragOver = ref<{ key: string; into: boolean; after?: boolean } | null>(null);
function itemDragOver(e: DragEvent, key: string) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  dragOver.value = { key, into: false, after: e.clientY > r.top + r.height / 2 };
}
function clearDrag() {
  draggingItem.value = null;
  draggingFolder.value = null;
  dragOver.value = null;
}
function onDropOnFolder(folderId: string) {
  if (draggingItem.value) org.setChatItemFolder(convId.value, draggingItem.value, folderId);
  else if (draggingFolder.value) org.setChatFolderParent(convId.value, draggingFolder.value, folderId);
  clearDrag();
}
function onDropOnItem(target: Item) {
  const dragged = draggingItem.value;
  const after = dragOver.value?.after ?? false;
  if (!dragged || dragged === target.key) {
    clearDrag();
    return;
  }
  const folderId = org.chatItemFolderOf(convId.value, target.key);
  org.setChatItemFolder(convId.value, dragged, folderId);
  const keys = itemsInFolder(folderId).map((i) => i.key).filter((k) => k !== dragged);
  const at = keys.indexOf(target.key);
  keys.splice(at < 0 ? keys.length : at + (after ? 1 : 0), 0, dragged);
  org.setChatItemOrder(convId.value, folderId, keys);
  clearDrag();
}
function onDropOnRoot() {
  if (draggingItem.value) org.setChatItemFolder(convId.value, draggingItem.value, null);
  else if (draggingFolder.value) org.setChatFolderParent(convId.value, draggingFolder.value, null);
  clearDrag();
}
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
      title="Show sidebar"
      @click="toggleOpen"
    >
      <IconPanelLeft class="h-5 w-5" />
    </button>
  </aside>

  <!-- Open: the unified channel/note tree. -->
  <aside
    v-else
    class="relative z-nav flex w-[var(--sw)] shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950"
    :style="{ '--sw': `${sidebarWidth}px` }"
  >
    <header class="flex items-center gap-0.5 px-2 py-2">
      <button
        class="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-200/70 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        aria-label="New folder"
        title="New folder"
        @click="createFolder"
      >
        <IconFolderPlus class="h-4 w-4" />
      </button>
      <button
        class="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-200/70 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        aria-label="Pin a note"
        title="Pin a note"
        @click="pinPickerOpen = true"
      >
        <IconPin class="h-4 w-4" />
      </button>
      <button
        v-if="canManage"
        class="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-200/70 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        aria-label="New channel"
        title="New channel"
        @click="openChannelCreate"
      >
        <IconPlus class="h-4 w-4" />
      </button>
      <span class="grow" />
      <button
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-200/70 dark:text-zinc-400 dark:hover:bg-zinc-800"
        aria-label="Hide channels"
        title="Hide sidebar"
        @click="toggleOpen"
      >
        <IconPanelLeft class="h-5 w-5" />
      </button>
    </header>

    <ul class="min-h-0 grow overflow-y-auto pb-2" @dragover.prevent @drop.prevent="onDropOnRoot">
      <!-- DMs have no channel list; a fixed "#chat" entry keeps the sidebar
           non-empty and gives a way back to the conversation (e.g. from a note). -->
      <li v-if="!isGroup" class="flex items-center">
        <button
          class="flex min-w-0 grow items-center gap-1.5 py-1.5 pl-2 pr-2 text-left text-sm"
          :class="channelActive(convId) ? 'bg-zinc-200 font-medium dark:bg-zinc-800' : 'text-zinc-600 hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-800/60'"
          @click="emit('select', convId)"
        >
          <IconHash class="h-4 w-4 shrink-0 opacity-60" />
          <span class="min-w-0 grow truncate">chat</span>
        </button>
      </li>
      <li
        v-for="row in treeRows"
        :key="row.key"
        class="group relative flex items-center"
        :class="[
          row.type === 'item' &&
          ((row.item!.kind === 'channel' && channelActive(row.item!.channel.id)) || (row.item!.kind === 'note' && noteActive(row.item!.noteId)))
            ? 'bg-zinc-200 dark:bg-zinc-800'
            : 'hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60',
          dragOver?.key === row.key && dragOver.into ? 'ring-2 ring-inset ring-blue-500' : '',
        ]"
      >
        <!-- Drop indicator: an insertion line above/below this row (no layout shift). -->
        <div
          v-if="dragOver?.key === row.key && !dragOver.into"
          class="pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-blue-500"
          :class="dragOver.after ? '-bottom-px' : '-top-px'"
        ></div>

        <!-- Folder row: clicking anywhere on the row toggles collapse; the hover
             buttons act on their own. The row is the drag handle + drop target. -->
        <template v-if="row.type === 'folder'">
          <button
            class="flex min-w-0 grow cursor-pointer items-center gap-1.5 py-1.5 pr-2 text-left text-sm font-medium text-zinc-600 dark:text-zinc-300"
            :style="{ paddingLeft: depthPad(row.depth) }"
            draggable="true"
            :title="isCollapsed(row.folder!.id) ? 'Expand' : 'Collapse'"
            @click="toggleCollapsed(row.folder!.id)"
            @dragstart.stop="draggingFolder = row.folder!.id"
            @dragend="clearDrag"
            @dragover.prevent="dragOver = { key: row.key, into: true }"
            @drop.stop.prevent="onDropOnFolder(row.folder!.id)"
          >
            <component :is="isCollapsed(row.folder!.id) ? IconFolderPlus : IconFolderMinus" class="h-[18px] w-[18px] shrink-0 opacity-60" />
            <span class="min-w-0 grow truncate"><EmojiText :text="row.folder!.name" /></span>
          </button>
          <div class="hidden shrink-0 items-center pr-1 group-hover:flex">
            <button class="rounded p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" title="New subfolder" @click="createSubfolder(row.folder!.id)"><IconFolderPlus class="h-3.5 w-3.5" /></button>
            <button class="rounded p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" title="Rename folder" @click="renameFolder(row.folder!.id, row.folder!.name)"><IconPencil class="h-3.5 w-3.5" /></button>
            <button class="rounded p-1 text-zinc-400 hover:text-red-600 dark:hover:text-red-400" title="Delete folder" @click="deleteFolder(row.folder!.id, row.folder!.name)"><IconTrash class="h-3.5 w-3.5" /></button>
          </div>
        </template>

        <!-- Item row: a channel or a pinned note. -->
        <template v-else>
          <button
            class="flex min-w-0 grow cursor-grab items-center gap-1.5 py-1.5 pr-2 text-left text-sm"
            :style="{ paddingLeft: depthPad(row.depth) }"
            :class="[
              (row.item!.kind === 'channel' && channelActive(row.item!.channel.id)) || (row.item!.kind === 'note' && noteActive(row.item!.noteId)) ? 'font-medium' : 'text-zinc-600 dark:text-zinc-300',
              row.item!.kind === 'channel' && row.item!.channel.type === 'voice' ? 'opacity-70' : '',
            ]"
            draggable="true"
            @click="selectItem(row.item!)"
            @dragstart.stop="draggingItem = row.item!.key"
            @dragend="clearDrag"
            @dragover.prevent="itemDragOver($event, row.key)"
            @drop.stop.prevent="onDropOnItem(row.item!)"
          >
            <template v-if="row.item!.kind === 'channel'">
              <IconVolume v-if="row.item!.channel.type === 'voice'" class="h-4 w-4 shrink-0 opacity-60" />
              <IconHash v-else class="h-4 w-4 shrink-0 opacity-60" />
              <span class="min-w-0 grow truncate"><EmojiText :text="row.item!.channel.name" /></span>
              <span
                v-if="unread(row.item!.channel) > 0 && row.item!.channel.id !== activeChannelId"
                class="ml-1 shrink-0 rounded-full bg-blue-600 px-1.5 text-[10px] font-semibold leading-4 text-white"
              >{{ unread(row.item!.channel) > 99 ? '99+' : unread(row.item!.channel) }}</span>
            </template>
            <template v-else>
              <IconNote class="h-4 w-4 shrink-0 opacity-50" />
              <span class="min-w-0 grow truncate"><EmojiText :text="row.item!.title" /></span>
            </template>
          </button>
          <!-- Hover actions: unpin a note, or manage a channel (managers, non-default). -->
          <div class="hidden shrink-0 items-center pr-1 group-hover:flex">
            <button v-if="row.item!.kind === 'note'" class="rounded p-1 text-zinc-400 hover:text-red-600 dark:hover:text-red-400" title="Unpin" @click="unpinNote(row.item!.noteId)"><IconX class="h-3.5 w-3.5" /></button>
            <template v-else-if="canManage && !row.item!.channel.isDefault">
              <button class="rounded p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" title="Rename channel" @click="openChannelRename(row.item!.channel)"><IconPencil class="h-3.5 w-3.5" /></button>
              <button class="rounded p-1 text-zinc-400 hover:text-red-600 dark:hover:text-red-400" title="Delete channel" @click="deleteChannel(row.item!.channel)"><IconTrash class="h-3.5 w-3.5" /></button>
            </template>
          </div>
        </template>
      </li>
    </ul>

    <ChannelModal
      v-model:open="channelModalOpen"
      :mode="channelMode"
      :initial-name="renameChannelTarget?.name"
      :busy="busy"
      @submit="onChannelSubmit"
    />
    <PinPickerModal v-model:open="pinPickerOpen" :conversation-id="convId" @open-note="emit('openNote', $event)" />
    <ResizeHandle :active="resizing" @start="startResize" />
  </aside>
</template>
