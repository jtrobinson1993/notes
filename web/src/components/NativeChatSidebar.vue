<script setup lang="ts">
// The per-conversation sidebar for the native (v8) chat surface — the same shape
// the legacy app's ChatSidebar has for a DM: a fixed "#chat" entry for the
// conversation itself, plus the personal tree of chat folders and pinned notes.
//
// It shares the org store's chat namespace (folders/pins keyed by conversation
// id), so the arrangement is personal to me and pinning a note does NOT share it.
// v8 groups have no sub-channels yet (the relay's group record carries members,
// not channels), so groups get the same tree — "#chat" is the group's one room.
import { ref } from 'vue';
import EmojiText from './EmojiText.vue';
import PinPickerModal from './PinPickerModal.vue';
import ResizeHandle from './ResizeHandle.vue';
import { useResizable } from '../lib/useResizable';
import { isCollapsed, toggleCollapsed } from '../lib/folderCollapse';
import { useNotesStore } from '../stores/notes';
import { noteItemKey, useOrgStore } from '../stores/organization';
import IconHash from '~icons/mynaui/hash';
import IconPanelLeft from '~icons/mynaui/panel-left';
import IconFolderMinus from '~icons/mynaui/folder-minus';
import IconFolderPlus from '~icons/mynaui/folder-plus';
import IconNote from '~icons/mynaui/file-text';
import IconPencil from '~icons/mynaui/pencil';
import IconPin from '~icons/mynaui/pin';
import IconTrash from '~icons/mynaui/trash';
import IconX from '~icons/mynaui/x';

const props = defineProps<{
  /** The open conversation's id — the org namespace these folders/pins live in. */
  conversationId: string;
  /** Shown in the mobile header (the chat header isn't visible on this pane). */
  title: string;
  /** The note open over the chat, if any — it, not "#chat", is the active row. */
  openNoteId?: string | null;
  mobile?: boolean;
}>();
const emit = defineEmits<{ select: []; openNote: [noteId: string] }>();

const notes = useNotesStore();
const org = useOrgStore();

const STORAGE_KEY = 'chat:channels:open';
const open = ref(localStorage.getItem(STORAGE_KEY) !== '0');
const { width: sidebarWidth, dragging: resizing, start: startResize } = useResizable('chat:sidebar:w', 224, 180, 420);
function toggleOpen() {
  open.value = !open.value;
  localStorage.setItem(STORAGE_KEY, open.value ? '1' : '0');
}

// ---- Items (pinned notes) ----
interface Item {
  key: string;
  noteId: string;
  title: string;
}
function allItems(): Item[] {
  return org
    .pinsFor(props.conversationId)
    .filter((p) => p.kind === 'note')
    .map((p) => ({
      key: noteItemKey(p.id),
      noteId: p.id,
      title: notes.notes.get(p.id)?.payload.title || 'Untitled',
    }));
}
function itemsInFolder(folderId: string | null): Item[] {
  const items = allItems();
  const byKey = new Map(items.map((i) => [i.key, i]));
  const keys = items.filter((i) => org.chatItemFolderOf(props.conversationId, i.key) === folderId).map((i) => i.key);
  return org
    .orderedChatItems(props.conversationId, folderId, keys)
    .map((k) => byKey.get(k)!)
    .filter(Boolean);
}

interface Row {
  key: string;
  type: 'folder' | 'item';
  depth: number;
  folder?: { id: string; name: string };
  item?: Item;
}
function treeRows(): Row[] {
  const out: Row[] = [];
  for (const it of itemsInFolder(null)) out.push({ key: `i:${it.key}`, type: 'item', depth: 0, item: it });
  const walk = (parentId: string | null, depth: number) => {
    for (const f of org.chatChildFolders(props.conversationId, parentId)) {
      out.push({ key: `f:${f.id}`, type: 'folder', depth, folder: f });
      if (isCollapsed(f.id)) continue;
      for (const it of itemsInFolder(f.id)) out.push({ key: `i:${it.key}`, type: 'item', depth: depth + 1, item: it });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function depthPad(depth: number): string {
  return `${depth * 14 + 8}px`;
}

// ---- Folders + pins (personal) ----
const pinPickerOpen = ref(false);
function createFolder() {
  const name = window.prompt('New folder name')?.trim();
  if (name) org.createChatFolder(props.conversationId, name);
}
function createSubfolder(parentId: string) {
  const name = window.prompt('New subfolder name')?.trim();
  if (name) org.createChatFolder(props.conversationId, name, parentId);
}
function renameFolder(id: string, current: string) {
  const name = window.prompt('Rename folder', current)?.trim();
  if (name) org.renameChatFolder(props.conversationId, id, name);
}
function deleteFolder(id: string, name: string) {
  if (!window.confirm(`Delete folder "${name}"? Its notes move out; nothing is deleted.`)) return;
  org.deleteChatFolder(props.conversationId, id);
}
function unpinNote(noteId: string) {
  org.unpin(props.conversationId, 'note', noteId);
}

// ---- Drag & drop (personal arrangement) ----
const draggingItem = ref<string | null>(null);
const draggingFolder = ref<string | null>(null);
// The row dragged over: `into` = drop inside a folder (ring); otherwise an
// insertion line before/after the row, by which half the cursor is over.
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
  if (draggingItem.value) org.setChatItemFolder(props.conversationId, draggingItem.value, folderId);
  else if (draggingFolder.value) org.setChatFolderParent(props.conversationId, draggingFolder.value, folderId);
  clearDrag();
}
function onDropOnItem(target: Item) {
  const dragged = draggingItem.value;
  const after = dragOver.value?.after ?? false;
  if (!dragged || dragged === target.key) {
    clearDrag();
    return;
  }
  const folderId = org.chatItemFolderOf(props.conversationId, target.key);
  org.setChatItemFolder(props.conversationId, dragged, folderId);
  const keys = itemsInFolder(folderId).map((i) => i.key).filter((k) => k !== dragged);
  const at = keys.indexOf(target.key);
  keys.splice(at < 0 ? keys.length : at + (after ? 1 : 0), 0, dragged);
  org.setChatItemOrder(props.conversationId, folderId, keys);
  clearDrag();
}
function onDropOnRoot() {
  if (draggingItem.value) org.setChatItemFolder(props.conversationId, draggingItem.value, null);
  else if (draggingFolder.value) org.setChatFolderParent(props.conversationId, draggingFolder.value, null);
  clearDrag();
}
</script>

<template>
  <!-- Collapsed: a slim rail with just the open toggle. (Never on mobile, where
       the sidebar is a full-screen pane.) -->
  <aside
    v-if="!open && !mobile"
    class="z-nav flex w-12 shrink-0 flex-col items-center border-r border-zinc-200 bg-zinc-50 pt-2 dark:border-zinc-800 dark:bg-zinc-950"
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

  <aside
    v-else
    class="relative z-nav flex flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950"
    :class="mobile ? 'w-full' : 'w-[var(--sw)] shrink-0'"
    :style="mobile ? undefined : { '--sw': `${sidebarWidth}px` }"
  >
    <header v-if="mobile" class="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <span class="min-w-0 grow truncate font-semibold">{{ title }}</span>
    </header>
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
      <span class="grow" />
      <button
        v-if="!mobile"
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-200/70 dark:text-zinc-400 dark:hover:bg-zinc-800"
        aria-label="Hide channels"
        title="Hide sidebar"
        @click="toggleOpen"
      >
        <IconPanelLeft class="h-5 w-5" />
      </button>
    </header>

    <ul class="min-h-0 grow overflow-y-auto pb-2" @dragover.prevent @drop.prevent="onDropOnRoot">
      <!-- The conversation itself: the way back to the messages from a note. -->
      <li class="flex items-center">
        <button
          data-testid="chat-item"
          class="flex min-w-0 grow items-center gap-1.5 py-1.5 pl-2 pr-2 text-left text-sm"
          :class="!openNoteId ? 'bg-zinc-200 font-medium dark:bg-zinc-800' : 'text-zinc-600 hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-800/60'"
          @click="emit('select')"
        >
          <IconHash class="h-4 w-4 shrink-0 opacity-60" />
          <span class="min-w-0 grow truncate">chat</span>
        </button>
      </li>

      <li
        v-for="row in treeRows()"
        :key="row.key"
        class="group relative flex items-center"
        :class="[
          row.type === 'item' && openNoteId === row.item!.noteId
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

        <!-- Folder row: clicking the row toggles collapse; hover buttons act on their own. -->
        <template v-if="row.type === 'folder'">
          <button
            data-testid="folder-row"
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
            <component :is="isCollapsed(row.folder!.id) ? IconFolderPlus : IconFolderMinus" class="h-4.5 w-4.5 shrink-0 opacity-60" />
            <span class="min-w-0 grow truncate"><EmojiText :text="row.folder!.name" :scope="`folder:${row.folder!.id}`" /></span>
          </button>
          <div class="hidden shrink-0 items-center pr-1 group-hover:flex">
            <button class="rounded p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" title="New subfolder" @click="createSubfolder(row.folder!.id)"><IconFolderPlus class="h-3.5 w-3.5" /></button>
            <button class="rounded p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" title="Rename folder" @click="renameFolder(row.folder!.id, row.folder!.name)"><IconPencil class="h-3.5 w-3.5" /></button>
            <button class="rounded p-1 text-zinc-400 hover:text-red-600 dark:hover:text-red-400" title="Delete folder" @click="deleteFolder(row.folder!.id, row.folder!.name)"><IconTrash class="h-3.5 w-3.5" /></button>
          </div>
        </template>

        <!-- Item row: a pinned note. -->
        <template v-else>
          <button
            data-testid="pinned-note"
            class="flex min-w-0 grow cursor-grab items-center gap-1.5 py-1.5 pr-2 text-left text-sm"
            :style="{ paddingLeft: depthPad(row.depth) }"
            :class="openNoteId === row.item!.noteId ? 'font-medium' : 'text-zinc-600 dark:text-zinc-300'"
            draggable="true"
            @click="emit('openNote', row.item!.noteId)"
            @dragstart.stop="draggingItem = row.item!.key"
            @dragend="clearDrag"
            @dragover.prevent="itemDragOver($event, row.key)"
            @drop.stop.prevent="onDropOnItem(row.item!)"
          >
            <IconNote class="h-4 w-4 shrink-0 opacity-50" />
            <span class="min-w-0 grow truncate"><EmojiText :text="row.item!.title" :scope="`note:${row.item!.noteId}`" /></span>
          </button>
          <div class="hidden shrink-0 items-center pr-1 group-hover:flex">
            <button class="rounded p-1 text-zinc-400 hover:text-red-600 dark:hover:text-red-400" title="Unpin" @click="unpinNote(row.item!.noteId)"><IconX class="h-3.5 w-3.5" /></button>
          </div>
        </template>
      </li>
    </ul>

    <PinPickerModal v-model:open="pinPickerOpen" :conversation-id="conversationId" @open-note="emit('openNote', $event)" />
    <ResizeHandle v-if="!mobile" :active="resizing" @start="startResize" />
  </aside>
</template>
