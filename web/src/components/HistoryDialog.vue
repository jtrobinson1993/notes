<script setup lang="ts">
import { ref, watch } from 'vue';
import { useQuery } from '@pinia/colada';
import type { NotePayload } from '@notes/shared';
import { api } from '../lib/api';
import { decryptNotePayload } from '../lib/crypto';
import { useNotesStore } from '../stores/notes';
import { useSessionStore } from '../stores/session';
import AppModal from './AppModal.vue';
import MarkdownView from './MarkdownView.vue';

const props = defineProps<{ noteId: string }>();

const session = useSessionStore();
const notes = useNotesStore();
const open = defineModel<boolean>('open', { default: false });
const preview = ref<{ versionId: number; createdAt: number; payload: NotePayload } | null>(null);
const error = ref('');

watch(open, (o) => {
  if (!o) preview.value = null;
});

const { data: versions } = useQuery({
  key: () => ['versions', props.noteId],
  query: () => api.noteVersions(props.noteId),
  enabled: () => open.value,
});

async function show(versionId: number, createdAt: number) {
  error.value = '';
  try {
    const v = await api.noteVersion(props.noteId, versionId);
    if (!session.mk) throw new Error('locked');
    const payload = await decryptNotePayload(session.mk, {
      id: props.noteId, ciphertext: v.ciphertext, iv: v.iv, wrappedKey: v.wrappedKey,
      createdAt: v.createdAt, updatedAt: v.createdAt, deleted: false,
    });
    preview.value = { versionId, createdAt, payload };
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'failed to load version';
  }
}

async function restore() {
  if (!preview.value) return;
  await notes.save(props.noteId, preview.value.payload);
  open.value = false;
  preview.value = null;
}
</script>

<template>
  <AppModal v-model:open="open" title="Version history" max-width="sm:max-w-2xl">
    <div class="flex h-full min-h-0 gap-4 pb-5">
      <ul class="w-44 shrink-0 overflow-y-auto">
        <li v-for="v in versions" :key="v.id">
          <button
            class="w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
            :class="{ 'bg-zinc-100 dark:bg-zinc-800': preview?.versionId === v.id }"
            @click="show(v.id, v.createdAt)"
          >
            {{ new Date(v.createdAt).toLocaleString() }}
          </button>
        </li>
        <li v-if="!versions?.length" class="px-2 py-1.5 text-sm text-zinc-400">No versions yet</li>
      </ul>
      <div class="min-w-0 grow overflow-y-auto">
        <template v-if="preview">
          <div class="mb-2 flex items-center gap-2">
            <p class="grow truncate font-semibold">{{ preview.payload.title || 'Untitled' }}</p>
            <button
              class="shrink-0 rounded-lg bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700"
              @click="restore"
            >
              Restore
            </button>
          </div>
          <MarkdownView :source="preview.payload.body" breaks />
          <p v-if="error" class="mt-2 text-sm text-red-600 dark:text-red-400">{{ error }}</p>
        </template>
        <p v-else class="text-sm text-zinc-400">Select a version to preview</p>
      </div>
    </div>
  </AppModal>
</template>
