<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery } from '@pinia/colada';
import AppLayout from '../components/AppLayout.vue';
import NoteEditor from '../components/NoteEditor.vue';
import { loadTagColors, tagColor, tagTextColor } from '../lib/tagColors';
import { toPlainText } from '../lib/transfer';
import { useNotesStore } from '../stores/notes';
import { useSessionStore } from '../stores/session';

const session = useSessionStore();
const notes = useNotesStore();

const search = ref('');
const activeTag = ref<string | null>(null);
const selectedId = ref<string | null>(null);

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
      await autoOpen();
    }
  },
  { immediate: true },
);

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return notes.sorted.filter((n) => {
    if (activeTag.value && !n.payload.tags.includes(activeTag.value)) return false;
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
