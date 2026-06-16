<script setup lang="ts">
import { ref } from 'vue';
import { useMutation, useQuery, useQueryCache } from '@pinia/colada';
import type { ShareAccess } from '@notes/shared';
import { api } from '../lib/api';
import { useNotesStore } from '../stores/notes';
import { useSessionStore } from '../stores/session';
import AppModal from './AppModal.vue';

const props = defineProps<{ noteId: string }>();

const session = useSessionStore();
const notes = useNotesStore();
const queryCache = useQueryCache();
const open = defineModel<boolean>('open', { default: false });
const error = ref('');

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
    <ul class="divide-y divide-zinc-100 pb-5 dark:divide-zinc-800">
      <li
        v-for="m in members?.filter((m) => m.id !== session.user?.id)"
        :key="m.id"
        class="flex items-center gap-2 py-2"
      >
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
      <li v-if="!members?.length" class="py-2 text-sm text-zinc-400">
        Add friends to share notes with them.
      </li>
    </ul>
    <p v-if="error" class="pb-4 text-sm text-red-600 dark:text-red-400">{{ error }}</p>
  </AppModal>
</template>
