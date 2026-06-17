<script setup lang="ts">
import { computed, ref } from 'vue';
import AppModal from './AppModal.vue';
import { useNotesStore } from '../stores/notes';
import { useOrgStore } from '../stores/organization';
import IconHash from '~icons/mynaui/hash';
import IconFolder from '~icons/mynaui/folder';
import IconNote from '~icons/mynaui/file-text';
import IconPlus from '~icons/mynaui/plus';
import IconFolderPlus from '~icons/mynaui/folder-plus';
import IconPin from '~icons/mynaui/pin';

// Pin existing notes/folders into one conversation's sidebar, or create a new
// note/folder (which also lands in the notes view) and pin it. Pinning is
// personal and does NOT share the item (sharing is v5).
const props = defineProps<{ conversationId: string }>();
const emit = defineEmits<{ openNote: [id: string] }>();
const open = defineModel<boolean>('open', { default: false });
const notes = useNotesStore();
const org = useOrgStore();

const search = ref('');
const items = computed(() => {
  const q = search.value.trim().toLowerCase();
  const folders = org.sortedFolders
    .filter((f) => !q || f.name.toLowerCase().includes(q))
    .map((f) => ({ kind: 'folder' as const, id: f.id, label: f.name }));
  const noteItems = notes.sorted
    .map((n) => ({ kind: 'note' as const, id: n.id, label: n.payload.title || 'Untitled' }))
    .filter((n) => !q || n.label.toLowerCase().includes(q));
  return [...folders, ...noteItems];
});

function toggle(kind: 'note' | 'folder', id: string) {
  if (org.isPinned(props.conversationId, kind, id)) org.unpin(props.conversationId, kind, id);
  else org.pin(props.conversationId, kind, id);
}

async function newNote() {
  const id = await notes.create({ title: 'Untitled' });
  org.pin(props.conversationId, 'note', id);
  open.value = false;
  emit('openNote', id);
}
function newFolder() {
  const name = window.prompt('New folder name')?.trim();
  if (!name) return;
  const id = org.createFolder(name);
  org.pin(props.conversationId, 'folder', id);
}
</script>

<template>
  <AppModal v-model:open="open" title="Pin to this chat" description="Pin notes or folders here for quick access. Pinning is private — it doesn't share them." max-width="sm:max-w-md">
    <div class="flex gap-2 pb-3">
      <button class="flex items-center gap-1.5 rounded-lg border border-zinc-300 px-2.5 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800" @click="newNote">
        <IconPlus class="h-4 w-4" /> New note
      </button>
      <button class="flex items-center gap-1.5 rounded-lg border border-zinc-300 px-2.5 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800" @click="newFolder">
        <IconFolderPlus class="h-4 w-4" /> New folder
      </button>
    </div>
    <input
      v-model="search"
      placeholder="Search notes & folders…"
      class="mb-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
    />
    <ul class="space-y-0.5 pb-2">
      <li v-for="item in items" :key="`${item.kind}:${item.id}`">
        <button
          class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
          @click="toggle(item.kind, item.id)"
        >
          <IconFolder v-if="item.kind === 'folder'" class="h-4 w-4 shrink-0 opacity-60" />
          <IconNote v-else class="h-4 w-4 shrink-0 opacity-60" />
          <span class="min-w-0 grow truncate">{{ item.label }}</span>
          <IconPin
            class="h-4 w-4 shrink-0"
            :class="org.isPinned(conversationId, item.kind, item.id) ? 'text-blue-600' : 'text-zinc-300 dark:text-zinc-600'"
          />
        </button>
      </li>
      <li v-if="items.length === 0" class="px-2 py-4 text-center text-sm text-zinc-400">No notes or folders yet</li>
    </ul>
  </AppModal>
</template>
