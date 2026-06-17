<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery } from '@pinia/colada';
import AppLayout from '../components/AppLayout.vue';
import NoteEditor from '../components/NoteEditor.vue';
import EmojiText from '../components/EmojiText.vue';
import { isCollapsed, toggleCollapsed } from '../lib/folderCollapse';
import { loadTagColors, tagColor, tagTextColor } from '../lib/tagColors';
import { toPlainText } from '../lib/transfer';
import { useNotesStore, type DecryptedNote } from '../stores/notes';
import { useOrgStore, type OrgFolder } from '../stores/organization';
import { useSessionStore } from '../stores/session';
import IconFolder from '~icons/mynaui/folder';
import IconFolderPlus from '~icons/mynaui/folder-plus';
import IconNote from '~icons/mynaui/file-text';
import IconPencil from '~icons/mynaui/pencil';
import IconTrash from '~icons/mynaui/trash';
import IconMenu from '~icons/mynaui/menu';

const session = useSessionStore();
const notes = useNotesStore();
const org = useOrgStore();
const route = useRoute();
const router = useRouter();

const search = ref('');
const activeTag = ref<string | null>(null);
const selectedId = ref<string | null>(null);
// The highlighted folder (selection only — the tree shows notes inline, so it
// doesn't filter). Set when opening a pinned folder from a chat sidebar.
const activeFolderId = ref<string | null>(null);

// Compact density: note rows show the name only (no tags/preview). Persisted.
const compact = ref(localStorage.getItem('notes:compact') === '1');
watch(compact, (c) => localStorage.setItem('notes:compact', c ? '1' : '0'));

// Opening a pinned note/folder from a chat sidebar navigates here with a query.
watch(
  () => route.query,
  (q) => {
    if (typeof q.note === 'string') selectedId.value = q.note;
    else if (typeof q.folder === 'string') activeFolderId.value = q.folder;
    else return;
    void router.replace({ path: '/', query: {} }); // consume it so a refresh is clean
  },
  { immediate: true },
);

// Notes in a folder (null = unfiled), in manual drag order then recency.
function notesOf(folderId: string | null): DecryptedNote[] {
  const inFolder = notes.sorted.filter((n) => org.folderOf(n.id) === folderId);
  const byId = new Map(inFolder.map((n) => [n.id, n]));
  return org.orderedNoteIds(folderId, [...byId.keys()]).map((id) => byId.get(id)!);
}

// Counts include descendants, so a parent folder reflects everything under it.
function notesInFolder(folderId: string): number {
  const ids = new Set(org.descendantFolderIds(folderId));
  return notes.sorted.filter((n) => {
    const f = org.folderOf(n.id);
    return f !== null && ids.has(f);
  }).length;
}

// The unified file tree flattened depth-first: each folder, then its notes, then
// its subfolders; unfiled notes sit at the root.
interface TreeRow {
  key: string;
  type: 'folder' | 'note';
  depth: number;
  folder?: OrgFolder;
  note?: DecryptedNote;
}
const treeRows = computed<TreeRow[]>(() => {
  const out: TreeRow[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const f of org.childFolders(parentId)) {
      out.push({ key: `f:${f.id}`, type: 'folder', depth, folder: f });
      if (isCollapsed(f.id)) continue; // hide a collapsed folder's contents
      for (const n of notesOf(f.id)) out.push({ key: `n:${n.id}`, type: 'note', depth: depth + 1, note: n });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  for (const n of notesOf(null)) out.push({ key: `n:${n.id}`, type: 'note', depth: 0, note: n });
  return out;
});

// Search / tag active → a flat result list instead of the tree.
const treeMode = computed(() => !search.value.trim() && !activeTag.value);
const searchResults = computed(() => {
  const q = search.value.trim().toLowerCase();
  return notes.sorted.filter((n) => {
    if (activeTag.value && !n.payload.tags.includes(activeTag.value)) return false;
    if (q && !n.payload.title.toLowerCase().includes(q) && !n.payload.body.toLowerCase().includes(q)) return false;
    return true;
  });
});

function depthPad(depth: number): string {
  return `${depth * 14 + 10}px`;
}

// ---- Folder CRUD ----
function createFolder() {
  const name = window.prompt('New folder name')?.trim();
  if (name) activeFolderId.value = org.createFolder(name);
}
function createSubfolder(parentId: string) {
  const name = window.prompt('New subfolder name')?.trim();
  if (name) activeFolderId.value = org.createFolder(name, parentId);
}
function renameFolder(id: string, current: string) {
  const name = window.prompt('Rename folder', current)?.trim();
  if (name) org.renameFolder(id, name);
}
function deleteFolder(id: string, name: string) {
  if (!window.confirm(`Delete folder "${name}"? Its notes become unfiled and any subfolders move up.`)) return;
  if (activeFolderId.value === id) activeFolderId.value = null;
  org.deleteFolder(id);
}

// ---- Drag & drop: nest folders, move/reorder notes ----
const draggingFolder = ref<string | null>(null);
const draggingNote = ref<string | null>(null);
// The row currently dragged over: `into` = drop inside a folder (ring), else an
// insertion line before the row. Absolutely positioned, so no layout shift.
const dragOver = ref<{ key: string; into: boolean } | null>(null);
function endDrag() {
  draggingFolder.value = null;
  draggingNote.value = null;
  dragOver.value = null;
}

// Drop onto a folder row: nest a dragged folder, or move a dragged note into it.
function onDropOnFolder(folderId: string) {
  if (draggingNote.value) org.setNoteFolder(draggingNote.value, folderId);
  else if (draggingFolder.value) org.setFolderParent(draggingFolder.value, folderId);
  endDrag();
}
// Drop a note onto another note: move it into that note's folder, just before it.
function onDropOnNote(target: DecryptedNote) {
  const dragged = draggingNote.value;
  if (!dragged || dragged === target.id) {
    endDrag();
    return;
  }
  const folderId = org.folderOf(target.id);
  org.setNoteFolder(dragged, folderId);
  const ids = notesOf(folderId)
    .map((n) => n.id)
    .filter((id) => id !== dragged);
  const idx = ids.indexOf(target.id);
  ids.splice(idx < 0 ? ids.length : idx, 0, dragged);
  org.setNoteOrder(folderId, ids);
  endDrag();
}
// Drop on empty tree space: move a note to unfiled / a folder to the top level.
function onDropOnRoot() {
  if (draggingNote.value) org.setNoteFolder(draggingNote.value, null);
  else if (draggingFolder.value) org.setFolderParent(draggingFolder.value, null);
  endDrag();
}

// Open the most recently edited note once notes are ready (or a fresh note if
// there are none). Desktop only: on mobile the list is the landing view.
let autoOpened = false;
async function autoOpen() {
  if (autoOpened || selectedId.value || !matchMedia('(min-width: 640px)').matches) return;
  autoOpened = true;
  selectedId.value = notes.sorted[0]?.id ?? (await notes.create());
}

// Instant load from the encrypted IndexedDB cache, then background sync.
useQuery({
  key: ['notes-sync'],
  query: async () => {
    if (!session.unlocked) return null;
    if (!notes.loaded) await notes.loadFromCache();
    await notes.sync();
    void loadTagColors();
    void org.load();
    await autoOpen();
    return notes.sorted.length;
  },
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
  staleTime: 30_000,
});

watch(
  () => session.unlocked,
  async (unlocked) => {
    if (unlocked) {
      await notes.loadFromCache();
      await notes.sync();
      void loadTagColors();
      void org.load();
      await autoOpen();
    }
  },
  { immediate: true },
);

const selected = computed(() => (selectedId.value ? (notes.notes.get(selectedId.value) ?? null) : null));

async function newNote() {
  selectedId.value = await notes.create();
}

function excerpt(body: string): string {
  return toPlainText(body.slice(0, 500)).replace(/\s+/g, ' ').trim().slice(0, 80);
}
</script>

<template>
  <AppLayout>
    <div class="flex h-full">
      <aside
        class="flex w-full flex-col border-r border-zinc-200 sm:w-72 dark:border-zinc-800"
        :class="{ 'hidden sm:flex': selected }"
      >
        <div class="flex gap-2 p-3">
          <input
            v-model="search"
            placeholder="Search notes…"
            class="w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button
            class="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            @click="newNote"
          >
            New
          </button>
        </div>

        <!-- Folders header: label + compact toggle + create folder. -->
        <div class="mb-1 flex items-center justify-between px-3">
          <span class="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Folders</span>
          <div class="flex items-center gap-0.5">
            <button
              class="flex h-6 w-6 items-center justify-center rounded-md"
              :class="compact ? 'bg-blue-600 text-white hover:bg-blue-700' : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200'"
              title="Compact view (names only)"
              @click="compact = !compact"
            >
              <IconMenu class="h-4 w-4" />
            </button>
            <button
              class="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              title="New folder"
              @click="createFolder"
            >
              <IconFolderPlus class="h-4 w-4" />
            </button>
          </div>
        </div>

        <div v-if="notes.allTags.length" class="flex flex-wrap gap-1 px-3 pb-2">
          <button
            v-for="tag in notes.allTags"
            :key="tag"
            class="rounded-full border px-2 py-0.5 text-xs"
            :class="
              activeTag === tag
                ? 'border-blue-600 bg-blue-600 text-white'
                : 'border-zinc-300 text-zinc-500 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400'
            "
            @click="activeTag = activeTag === tag ? null : tag"
          >
            {{ tag }}
          </button>
        </div>

        <!-- The file tree (folders + nested notes); drop on empty space to unfile
             a note / move a folder to the top level. Full-width, borderless rows. -->
        <ul
          class="min-h-0 grow overflow-y-auto pb-2"
          @dragover.prevent
          @drop.prevent="onDropOnRoot"
        >
          <template v-if="treeMode">
            <li
              v-for="row in treeRows"
              :key="row.key"
              class="group relative flex items-center"
              :class="[
                (row.type === 'note' && selectedId === row.note!.id) || (row.type === 'folder' && activeFolderId === row.folder!.id)
                  ? 'bg-zinc-100 dark:bg-zinc-800'
                  : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60',
                dragOver?.key === row.key && dragOver.into ? 'ring-2 ring-inset ring-blue-500' : '',
              ]"
            >
              <!-- Drop indicator: an insertion line before this row (no layout shift). -->
              <div v-if="dragOver?.key === row.key && !dragOver.into" class="pointer-events-none absolute inset-x-0 -top-px z-10 h-0.5 bg-blue-500"></div>

              <!-- Folder row: clicking anywhere on the row toggles collapse; the
                   hover buttons act on their own. The row is the drag handle + a
                   drop target (drop into the folder). -->
              <template v-if="row.type === 'folder'">
                <button
                  class="flex min-w-0 grow cursor-pointer items-center gap-1.5 py-1.5 pr-2 text-left text-sm"
                  :style="{ paddingLeft: depthPad(row.depth) }"
                  draggable="true"
                  :title="isCollapsed(row.folder!.id) ? 'Expand' : 'Collapse'"
                  @click="toggleCollapsed(row.folder!.id)"
                  @dragstart.stop="draggingFolder = row.folder!.id"
                  @dragend="endDrag"
                  @dragover.prevent="dragOver = { key: row.key, into: true }"
                  @drop.stop.prevent="onDropOnFolder(row.folder!.id)"
                >
                  <IconFolder class="h-4 w-4 shrink-0" :class="isCollapsed(row.folder!.id) ? 'opacity-90' : 'opacity-50'" />
                  <span class="min-w-0 grow truncate font-medium"><EmojiText :text="row.folder!.name" /></span>
                  <span class="text-xs text-zinc-400">{{ notesInFolder(row.folder!.id) }}</span>
                </button>
                <div class="hidden shrink-0 items-center pr-1 group-hover:flex">
                  <button class="rounded p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" title="New subfolder" @click="createSubfolder(row.folder!.id)"><IconFolderPlus class="h-3.5 w-3.5" /></button>
                  <button class="rounded p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" title="Rename folder" @click="renameFolder(row.folder!.id, row.folder!.name)"><IconPencil class="h-3.5 w-3.5" /></button>
                  <button class="rounded p-1 text-zinc-400 hover:text-red-600 dark:hover:text-red-400" title="Delete folder" @click="deleteFolder(row.folder!.id, row.folder!.name)"><IconTrash class="h-3.5 w-3.5" /></button>
                </div>
              </template>

              <!-- Note row. -->
              <button
                v-else
                class="flex min-w-0 grow cursor-grab items-start gap-1.5 py-1.5 pr-3 text-left"
                :style="{ paddingLeft: depthPad(row.depth) }"
                draggable="true"
                @click="selectedId = row.note!.id"
                @dragstart.stop="draggingNote = row.note!.id"
                @dragend="endDrag"
                @dragover.prevent="dragOver = { key: row.key, into: false }"
                @drop.stop.prevent="onDropOnNote(row.note!)"
              >
                <IconNote class="mt-0.5 h-4 w-4 shrink-0 opacity-50" />
                <div class="min-w-0 grow">
                  <p class="truncate text-sm" :class="selectedId === row.note!.id ? 'font-medium' : ''">
                    <EmojiText :text="row.note!.payload.title || 'Untitled'" />
                    <span v-if="row.note!.shared" class="text-xs font-normal text-violet-500">· {{ row.note!.shared.ownerDisplayName }}</span>
                  </p>
                  <div v-if="!compact" class="flex items-center gap-1 overflow-hidden text-xs text-zinc-500 dark:text-zinc-400">
                    <span
                      v-for="tag in row.note!.payload.tags"
                      :key="tag"
                      class="shrink-0 rounded-full px-1.5 py-px text-[10px] leading-tight"
                      :style="{ background: tagColor(tag), color: tagTextColor(tagColor(tag)) }"
                    >{{ tag }}</span>
                    <span class="truncate">{{ excerpt(row.note!.payload.body) || 'Empty note' }}</span>
                  </div>
                </div>
              </button>
            </li>
            <li v-if="notes.loaded && treeRows.length === 0" class="p-4 text-center text-sm text-zinc-400">
              No notes yet
            </li>
          </template>

          <!-- Flat results when searching / filtering by tag. -->
          <template v-else>
            <li
              v-for="note in searchResults"
              :key="note.id"
              class="flex"
              :class="selectedId === note.id ? 'bg-zinc-100 dark:bg-zinc-800' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60'"
            >
              <button class="flex min-w-0 grow items-start gap-1.5 py-1.5 pl-3 pr-3 text-left" @click="selectedId = note.id">
                <IconNote class="mt-0.5 h-4 w-4 shrink-0 opacity-50" />
                <div class="min-w-0 grow">
                  <p class="truncate text-sm" :class="selectedId === note.id ? 'font-medium' : ''">
                    <EmojiText :text="note.payload.title || 'Untitled'" />
                    <span v-if="note.shared" class="text-xs font-normal text-violet-500">· {{ note.shared.ownerDisplayName }}</span>
                  </p>
                  <div v-if="!compact" class="flex items-center gap-1 overflow-hidden text-xs text-zinc-500 dark:text-zinc-400">
                    <span
                      v-for="tag in note.payload.tags"
                      :key="tag"
                      class="shrink-0 rounded-full px-1.5 py-px text-[10px] leading-tight"
                      :style="{ background: tagColor(tag), color: tagTextColor(tagColor(tag)) }"
                    >{{ tag }}</span>
                    <span class="truncate">{{ excerpt(note.payload.body) || 'Empty note' }}</span>
                  </div>
                </div>
              </button>
            </li>
            <li v-if="notes.loaded && searchResults.length === 0" class="p-4 text-center text-sm text-zinc-400">
              No matches
            </li>
          </template>
        </ul>
      </aside>

      <section class="min-w-0 grow" :class="{ 'hidden sm:block': !selected }">
        <div v-if="selected" class="h-full">
          <button
            class="px-4 pt-3 text-sm text-zinc-500 sm:hidden"
            @click="selectedId = null"
          >
            ← All notes
          </button>
          <NoteEditor :note="selected" @deleted="selectedId = null" />
        </div>
        <div v-else class="flex h-full items-center justify-center text-sm text-zinc-400">
          Select or create a note
        </div>
      </section>
    </div>
  </AppLayout>
</template>
