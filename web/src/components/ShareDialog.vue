<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useMutation, useQuery, useQueryCache } from '@pinia/colada';
import type { ShareAccess } from '@notes/shared';
import { api } from '../lib/api';
import { useNotesStore } from '../stores/notes';
import { useSessionStore } from '../stores/session';
import AppModal from './AppModal.vue';
import IconSearch from '~icons/mynaui/search';

const props = defineProps<{ noteId: string }>();

const session = useSessionStore();
const notes = useNotesStore();
const queryCache = useQueryCache();
const open = defineModel<boolean>('open', { default: false });
const error = ref('');
const search = ref('');

watch(open, (o) => {
  if (!o) search.value = '';
});

const { data: members } = useQuery({
  key: () => ['members'],
  query: () => api.members(),
  enabled: () => open.value,
});
const { data: shares } = useQuery({
  key: () => ['shares', props.noteId],
  query: () => api.noteShares(props.noteId),
  enabled: () => open.value,
});

// Friends (members are friends-only now), minus me, filtered by the search box.
const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return (members.value ?? [])
    .filter((m) => m.id !== session.user?.id && (!q || m.displayName.toLowerCase().includes(q)))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
});

function shareOf(memberId: string) {
  return shares.value?.find((s) => s.recipientId === memberId);
}

const toggleShare = useMutation({
  mutation: async ({ memberId, publicKey, access }: { memberId: string; publicKey: string | null; access: ShareAccess | null }) => {
    error.value = '';
    if (access === null) {
      await api.unshareNote(props.noteId, memberId);
    } else {
      if (!publicKey) throw new Error('user has not finished setting up their keys');
      await notes.shareWith(props.noteId, memberId, publicKey, access);
    }
  },
  onSettled: () => queryCache.invalidateQueries({ key: ['shares', props.noteId] }),
  onError: (e) => (error.value = e instanceof Error ? e.message : 'share failed'),
});
</script>

<template>
  <AppModal
    v-model:open="open"
    title="Share note"
    description="Share with a friend — the note's key is encrypted to them, so the server still can't read it."
  >
    <div class="sticky top-0 bg-white pb-2 dark:bg-zinc-900">
      <div class="relative">
        <IconSearch class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
        <input
          v-model="search"
          type="text"
          placeholder="Search friends…"
          class="w-full rounded-lg border border-zinc-300 bg-white py-2 pl-9 pr-3 text-sm placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
        />
      </div>
    </div>

    <ul class="divide-y divide-zinc-100 pb-5 dark:divide-zinc-800">
      <li v-for="m in filtered" :key="m.id" class="flex items-center gap-2 py-2">
        <span class="grow text-sm font-medium">{{ m.displayName }}</span>
        <select
          :value="shareOf(m.id)?.access ?? 'none'"
          class="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          @change="
            toggleShare.mutate({
              memberId: m.id,
              publicKey: m.publicKey,
              access: (($event.target as HTMLSelectElement).value === 'none'
                ? null
                : ($event.target as HTMLSelectElement).value) as ShareAccess | null,
            })
          "
        >
          <option value="none">No access</option>
          <option value="read">Can read</option>
          <option value="write">Can edit</option>
        </select>
      </li>
      <li v-if="!filtered.length" class="py-2 text-sm text-zinc-400">
        {{ members?.length ? 'No friends match your search.' : 'Add friends to share notes with them.' }}
      </li>
    </ul>
    <p v-if="error" class="pb-4 text-sm text-red-600 dark:text-red-400">{{ error }}</p>
  </AppModal>
</template>
