<script setup lang="ts">
import { ref } from 'vue';
import {
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui';
import { useMutation, useQuery, useQueryCache } from '@pinia/colada';
import type { ShareAccess } from '@notes/shared';
import { api } from '../lib/api';
import { useNotesStore } from '../stores/notes';
import { useSessionStore } from '../stores/session';

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
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-20 bg-black/40" />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-30 w-[90vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-5 shadow-xl dark:bg-zinc-900"
      >
        <DialogTitle class="mb-1 text-lg font-semibold">Share note</DialogTitle>
        <p class="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
          The note's key is encrypted to each person you share with — the server still can't read it.
        </p>
        <ul class="divide-y divide-zinc-100 dark:divide-zinc-800">
          <li
            v-for="m in members?.filter((m) => m.id !== session.user?.id)"
            :key="m.id"
            class="flex items-center gap-2 py-2"
          >
            <span class="grow text-sm font-medium">{{ m.username }}</span>
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
          <li v-if="(members?.length ?? 0) <= 1" class="py-2 text-sm text-zinc-400">
            No other users on this server yet.
          </li>
        </ul>
        <p v-if="error" class="mt-2 text-sm text-red-600 dark:text-red-400">{{ error }}</p>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
