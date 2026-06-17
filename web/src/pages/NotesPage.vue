<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery } from '@pinia/colada';
import AppLayout from '../components/AppLayout.vue';
import NoteEditor from '../components/NoteEditor.vue';
import { loadTagColors, tagColor, tagTextColor } from '../lib/tagColors';
import { toPlainText } from '../lib/transfer';
import { useNotesStore } from '../stores/notes';
import { useOrgStore } from '../stores/organization';
import { useSessionStore } from '../stores/session';
import IconFolder from '~icons/mynaui/folder';
import IconFolderPlus from '~icons/mynaui/folder-plus';
import IconPencil from '~icons/mynaui/pencil';
import IconTrash from '~icons/mynaui/trash';

const session = useSessionStore();
const notes = useNotesStore();
const org = useOrgStore();
const route = useRoute();
const router = useRouter();

const search = ref('');
const activeTag = ref<string | null>(null);
const selectedId = ref<string | null>(null);
// Folder filter: null = all notes, 'unfiled' = notes with no folder, else a folder id.
const activeFolder = ref<string | null | 'unfiled'>(null);

// Opening a pinned note/folder from a chat sidebar navigates here with a query.
watch(
  () => route.query,
  (q) => {
    if (typeof q.note === 'string') {
      selectedId.value = q.note;
      activeFolder.value = null;
    } else if (typeof q.folder === 'string') {
      activeFolder.value = q.folder;
    } else {
      return;
    }
    void router.replace({ path: '/', query: {} }); // consume it so a refresh is clean
  },
  { immediate: true },
);

function notesInFolder(folderId: string): number {
  return notes.sorted.filter((n) => org.folderOf(n.id) === folderId).length;
}
const unfiledCount = computed(() => notes.sorted.filter((n) => org.folderOf(n.id) === null).length);

function createFolder() {
  const name = window.prompt('New folder name')?.trim();
  if (name) {
    const id = org.createFolder(name);
    activeFolder.value = id;
  }
}
function renameFolder(id: string, current: string) {
  const name = window.prompt('Rename folder', current)?.trim();
  if (name) org.renameFolder(id, name);
}
function deleteFolder(id: string, name: string) {
  if (!window.confirm(`Delete folder "${name}"? Its notes stay, but become unfiled.`)) return;
  if (activeFolder.value === id) activeFolder.value = null;
  org.deleteFolder(id);
}

// Open the most recently edited note once notes are ready (or a fresh note if
// there are none). Desktop only: on mobile the list is the landing view.
let autoOpened = false;
async function autoOpen() {
  if (autoOpened || selectedId.value || !matchMedia('(min-width: 640px)').matches) return;
  autoOpened = true;
  selectedId.value = notes.sorted[0]?.id ?? (await notes.create());
}

// Instant load from the encrypted IndexedDB cache, then background sync
// (Pinia Colada refetches on focus/reconnect).
useQuery({
  key: ['notes-sync'],
  query: async () => {
    if (!session.unlocked) return null;
    if (!notes.loaded) await notes.loadFromCache();
    await notes.sync();
    void loadTagColors();
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

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return notes.sorted.filter((n) => {
    if (activeTag.value && !n.payload.tags.includes(activeTag.value)) return false;
    const folder = org.folderOf(n.id);
    if (activeFolder.value === 'unfiled' && folder !== null) return false;
    if (activeFolder.value && activeFolder.value !== 'unfiled' && folder !== activeFolder.value) return false;
    if (q && !n.payload.title.toLowerCase().includes(q) && !n.payload.body.toLowerCase().includes(q)) return false;
    return true;
  });
});

const selected = computed(() => (selectedId.value ? (notes.notes.get(selectedId.value) ?? null) : null));

async function newNote() {
  selectedId.value = await notes.create();
}

function excerpt(body: string): string {
  // strip markup from just enough of the body for an 80-char preview
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

        <!-- Folders (personal organization). -->
        <div class="px-3 pb-2">
          <div class="mb-1 flex items-center justify-between">
            <span class="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Folders</span>
            <button
              class="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              title="New folder"
              @click="createFolder"
            >
              <IconFolderPlus class="h-4 w-4" />
            </button>
          </div>
          <ul class="space-y-0.5 text-sm">
            <li>
              <button
                class="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left"
                :class="activeFolder === null ? 'bg-zinc-200 font-medium dark:bg-zinc-800' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800/60'"
                @click="activeFolder = null"
              >
                <IconFolder class="h-3.5 w-3.5 shrink-0 opacity-60" />
                <span class="grow truncate">All notes</span>
                <span class="text-xs text-zinc-400">{{ notes.sorted.length }}</span>
              </button>
            </li>
            <li v-for="f in org.sortedFolders" :key="f.id" class="group/folder flex items-center gap-0.5">
              <button
                class="flex min-w-0 grow items-center gap-1.5 rounded-md px-2 py-1 text-left"
                :class="activeFolder === f.id ? 'bg-zinc-200 font-medium dark:bg-zinc-800' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800/60'"
                @click="activeFolder = f.id"
              >
                <IconFolder class="h-3.5 w-3.5 shrink-0 opacity-60" />
                <span class="min-w-0 grow truncate">{{ f.name }}</span>
                <span class="text-xs text-zinc-400">{{ notesInFolder(f.id) }}</span>
              </button>
              <button class="hidden rounded p-1 text-zinc-400 hover:text-zinc-700 group-hover/folder:block dark:hover:text-zinc-200" title="Rename folder" @click="renameFolder(f.id, f.name)"><IconPencil class="h-3 w-3" /></button>
              <button class="hidden rounded p-1 text-zinc-400 hover:text-red-600 group-hover/folder:block dark:hover:text-red-400" title="Delete folder" @click="deleteFolder(f.id, f.name)"><IconTrash class="h-3 w-3" /></button>
            </li>
            <li v-if="unfiledCount > 0 && org.sortedFolders.length">
              <button
                class="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left"
                :class="activeFolder === 'unfiled' ? 'bg-zinc-200 font-medium dark:bg-zinc-800' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800/60'"
                @click="activeFolder = 'unfiled'"
              >
                <IconFolder class="h-3.5 w-3.5 shrink-0 opacity-40" />
                <span class="grow truncate text-zinc-500">Unfiled</span>
                <span class="text-xs text-zinc-400">{{ unfiledCount }}</span>
              </button>
            </li>
          </ul>
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

        <ul class="min-h-0 grow overflow-y-auto">
          <li v-for="note in filtered" :key="note.id">
            <button
              class="w-full border-b border-zinc-100 px-3 py-2.5 text-left hover:bg-zinc-100 dark:border-zinc-900 dark:hover:bg-zinc-900"
              :class="{ 'bg-zinc-100 dark:bg-zinc-900': selectedId === note.id }"
              @click="selectedId = note.id"
            >
              <p class="truncate text-sm font-medium">
                {{ note.payload.title || 'Untitled' }}
                <span v-if="note.shared" class="text-xs font-normal text-violet-500">· from {{ note.shared.ownerDisplayName }}</span>
              </p>
              <div class="flex items-center gap-1 overflow-hidden text-xs text-zinc-500 dark:text-zinc-400">
                <span
                  v-for="tag in note.payload.tags"
                  :key="tag"
                  class="shrink-0 rounded-full px-1.5 py-px text-[10px] leading-tight"
                  :style="{ background: tagColor(tag), color: tagTextColor(tagColor(tag)) }"
                >
                  {{ tag }}
                </span>
                <span class="truncate">{{ excerpt(note.payload.body) || 'Empty note' }}</span>
              </div>
            </button>
          </li>
          <li v-if="notes.loaded && filtered.length === 0" class="p-4 text-center text-sm text-zinc-400">
            No notes yet
          </li>
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
