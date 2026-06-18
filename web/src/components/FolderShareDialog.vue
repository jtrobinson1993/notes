<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery } from '@pinia/colada';
import AppModal from './AppModal.vue';
import EmojiText from './EmojiText.vue';
import { api } from '../lib/api';
import { useNotesStore } from '../stores/notes';
import type { ShareAccess } from '@notes/shared';
import IconCheck from '~icons/mynaui/check';

// Share every note in a folder (+ subfolders) with the chosen people. This is a
// one-time recursive snapshot grant — there's no folder-level permission record,
// so notes added later aren't auto-shared. Only OWNED notes are shared.
const props = defineProps<{ folderId: string; folderName: string }>();
const open = defineModel<boolean>('open', { default: false });
const notes = useNotesStore();

const { data: members } = useQuery({ key: () => ['members'], query: () => api.members() });
const search = ref('');
const selected = ref(new Set<string>());
const access = ref<ShareAccess>('read');
const busy = ref(false);
const done = ref(false);
const error = ref('');

watch(open, (o) => {
  if (o) {
    selected.value = new Set();
    search.value = '';
    access.value = 'read';
    done.value = false;
    error.value = '';
  }
});

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return (members.value ?? []).filter((m) => !q || m.displayName.toLowerCase().includes(q));
});

function toggle(id: string) {
  const next = new Set(selected.value);
  next.has(id) ? next.delete(id) : next.add(id);
  selected.value = next;
}

async function share() {
  if (!selected.value.size || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const recipients = (members.value ?? [])
      .filter((m) => selected.value.has(m.id))
      .map((m) => ({ id: m.id, publicKey: m.publicKey }));
    await notes.shareFolder(props.folderId, recipients, access.value);
    done.value = true;
    setTimeout(() => (open.value = false), 900);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'share failed';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AppModal v-model:open="open" title="Share folder" :description="`Grant access to every note in “${folderName}” and its subfolders. A one-time grant — notes added later won't be shared automatically.`" max-width="sm:max-w-md">
    <div class="flex items-center gap-2 pb-2">
      <input
        v-model="search"
        placeholder="Search people…"
        class="w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
      />
      <select v-model="access" class="shrink-0 rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900">
        <option value="read">Can read</option>
        <option value="write">Can edit</option>
      </select>
    </div>
    <ul class="space-y-0.5 pb-2">
      <li v-for="m in filtered" :key="m.id">
        <button
          class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
          @click="toggle(m.id)"
        >
          <span class="flex h-4 w-4 shrink-0 items-center justify-center rounded border" :class="selected.has(m.id) ? 'border-blue-600 bg-blue-600 text-white' : 'border-zinc-300 dark:border-zinc-600'">
            <IconCheck v-if="selected.has(m.id)" class="h-3 w-3" />
          </span>
          <span class="min-w-0 grow truncate"><EmojiText :text="m.displayName" /></span>
          <span v-if="!m.publicKey" class="shrink-0 text-xs text-zinc-400">no key yet</span>
        </button>
      </li>
      <li v-if="filtered.length === 0" class="px-2 py-4 text-center text-sm text-zinc-400">No friends or chat members yet</li>
    </ul>
    <p v-if="error" class="px-1 pb-2 text-sm text-red-500">{{ error }}</p>
    <template #footer>
      <button class="rounded-lg px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800" @click="open = false">Cancel</button>
      <button
        :disabled="!selected.size || busy"
        class="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        @click="share"
      >
        {{ done ? 'Shared ✓' : busy ? 'Sharing…' : `Share with ${selected.size || ''}` }}
      </button>
    </template>
  </AppModal>
</template>
