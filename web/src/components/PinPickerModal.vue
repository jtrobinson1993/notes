<script setup lang="ts">
import { computed, ref } from 'vue';
import AppModal from './AppModal.vue';
import EmojiText from './EmojiText.vue';
import { useNotesStore } from '../stores/notes';
import { useOrgStore } from '../stores/organization';
import IconNote from '~icons/mynaui/file-text';
import IconPlus from '~icons/mynaui/plus';
import IconPin from '~icons/mynaui/pin';

// Pin existing notes into one conversation's sidebar, or create a new note
// (which also lands in the notes view) and pin it. Pinning is personal and does
// NOT share the note (sharing is v5). Group notes with chat folders in the
// sidebar itself.
const props = defineProps<{ conversationId: string }>();
const emit = defineEmits<{ openNote: [id: string] }>();
const open = defineModel<boolean>('open', { default: false });
const notes = useNotesStore();
const org = useOrgStore();

const search = ref('');
const items = computed(() => {
  const q = search.value.trim().toLowerCase();
  return notes.sorted
    .map((n) => ({ id: n.id, label: n.payload.title || 'Untitled' }))
    .filter((n) => !q || n.label.toLowerCase().includes(q));
});

function toggle(id: string) {
  if (org.isPinned(props.conversationId, 'note', id)) org.unpin(props.conversationId, 'note', id);
  else org.pin(props.conversationId, 'note', id);
}

async function newNote() {
  const id = await notes.create({ title: 'Untitled' });
  org.pin(props.conversationId, 'note', id);
  open.value = false;
  emit('openNote', id);
}
</script>

<template>
  <AppModal v-model:open="open" title="Pin a note" description="Pin notes here for quick access — rules, character sheets, co-working docs. Pinning is private; it doesn't share the note." max-width="sm:max-w-md">
    <div class="flex gap-2 pb-3">
      <button class="flex items-center gap-1.5 rounded-lg border border-zinc-300 px-2.5 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800" @click="newNote">
        <IconPlus class="h-4 w-4" /> New note
      </button>
    </div>
    <input
      v-model="search"
      placeholder="Search notes…"
      class="mb-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
    />
    <ul class="space-y-0.5 pb-2">
      <li v-for="item in items" :key="item.id">
        <button
          class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
          @click="toggle(item.id)"
        >
          <IconNote class="h-4 w-4 shrink-0 opacity-60" />
          <span class="min-w-0 grow truncate"><EmojiText :text="item.label" /></span>
          <IconPin
            class="h-4 w-4 shrink-0"
            :class="org.isPinned(conversationId, 'note', item.id) ? 'text-blue-600' : 'text-zinc-300 dark:text-zinc-600'"
          />
        </button>
      </li>
      <li v-if="items.length === 0" class="px-2 py-4 text-center text-sm text-zinc-400">No notes yet</li>
    </ul>
  </AppModal>
</template>
