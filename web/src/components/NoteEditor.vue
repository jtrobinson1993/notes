<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'reka-ui';
import type { AttachmentRef } from '@notes/shared';
import { api } from '../lib/api';
import { decryptBlob, encryptBlob } from '../lib/crypto';
import { useNotesStore, type DecryptedNote } from '../stores/notes';
import MarkdownEditor from './MarkdownEditor.vue';
import MarkdownView from './MarkdownView.vue';
import ShareDialog from './ShareDialog.vue';
import HistoryDialog from './HistoryDialog.vue';

const props = defineProps<{ note: DecryptedNote }>();
const emit = defineEmits<{ deleted: [] }>();

const notes = useNotesStore();
const title = ref(props.note.payload.title);
const body = ref(props.note.payload.body);
const tagsInput = ref(props.note.payload.tags.join(', '));
const attachments = ref<AttachmentRef[]>(props.note.payload.attachments ?? []);
const tab = ref('write');
const saveState = ref<'saved' | 'saving' | 'error'>('saved');
const fileInput = ref<HTMLInputElement>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const readonly = computed(() => props.note.shared?.access === 'read');
const isOwner = computed(() => !props.note.shared);

watch(
  () => props.note.id,
  () => {
    if (saveTimer) clearTimeout(saveTimer);
    title.value = props.note.payload.title;
    body.value = props.note.payload.body;
    tagsInput.value = props.note.payload.tags.join(', ');
    attachments.value = props.note.payload.attachments ?? [];
    saveState.value = 'saved';
  },
);

watch([title, body, tagsInput], () => {
  if (readonly.value) return;
  saveState.value = 'saving';
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 800);
});

async function save() {
  const tags = [...new Set(tagsInput.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))];
  try {
    await notes.save(props.note.id, {
      title: title.value,
      body: body.value,
      tags,
      attachments: attachments.value.length ? attachments.value : undefined,
    });
    saveState.value = notes.pendingCount > 0 ? 'error' : 'saved';
  } catch {
    saveState.value = 'error';
  }
}

async function attach(event: Event) {
  const files = (event.target as HTMLInputElement).files;
  if (!files) return;
  for (const file of files) {
    const data = new Uint8Array(await file.arrayBuffer());
    const { ciphertext, key, iv } = await encryptBlob(data);
    const { id } = await api.attachmentUpload(ciphertext);
    attachments.value.push({ id, name: file.name, type: file.type || 'application/octet-stream', size: file.size, key, iv });
    if (file.type.startsWith('image/')) {
      body.value += `${body.value.endsWith('\n') || !body.value ? '' : '\n\n'}![${file.name}](attachment:${id})\n`;
    }
  }
  (event.target as HTMLInputElement).value = '';
  await save();
}

async function download(ref: AttachmentRef) {
  const ct = await api.attachmentDownload(ref.id);
  const data = await decryptBlob(ct, ref.key, ref.iv);
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: ref.type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = ref.name;
  a.click();
  URL.revokeObjectURL(url);
}

async function removeAttachment(refToRemove: AttachmentRef) {
  attachments.value = attachments.value.filter((a) => a.id !== refToRemove.id);
  body.value = body.value.replaceAll(`![${refToRemove.name}](attachment:${refToRemove.id})`, '');
  await save();
  await api.attachmentDelete(refToRemove.id).catch(() => {}); // uploader-owned; best effort
}

async function remove() {
  if (!confirm('Delete this note?')) return;
  await notes.remove(props.note.id);
  emit('deleted');
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
</script>

<template>
  <div class="flex h-full flex-col p-4">
    <div class="mb-2 flex items-center gap-1">
      <input
        v-model="title"
        placeholder="Untitled"
        :readonly="readonly"
        class="min-w-0 grow bg-transparent text-xl font-semibold outline-none placeholder:text-zinc-400"
      />
      <span v-if="note.shared" class="shrink-0 rounded-full bg-violet-100 px-2 py-0.5 text-xs text-violet-700 dark:bg-violet-950 dark:text-violet-300">
        {{ note.shared.ownerUsername }} · {{ note.shared.access === 'read' ? 'read-only' : 'can edit' }}
      </span>
      <span class="shrink-0 px-1 text-xs text-zinc-400">
        {{ saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Queued (offline)' : 'Saved' }}
      </span>
      <ShareDialog v-if="isOwner" :note-id="note.id" />
      <HistoryDialog v-if="isOwner" :note-id="note.id" />
      <button
        v-if="!readonly"
        class="shrink-0 rounded-lg px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        @click="fileInput?.click()"
      >
        Attach
      </button>
      <input ref="fileInput" type="file" multiple class="hidden" @change="attach" />
      <button
        v-if="isOwner"
        class="shrink-0 rounded-lg px-2 py-1 text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
        @click="remove"
      >
        Delete
      </button>
    </div>

    <input
      v-model="tagsInput"
      placeholder="tags, comma, separated"
      :readonly="readonly"
      class="mb-2 w-full bg-transparent text-sm text-zinc-500 outline-none placeholder:text-zinc-400 dark:text-zinc-400"
    />

    <div v-if="attachments.length" class="mb-2 flex flex-wrap gap-1.5">
      <span
        v-for="a in attachments"
        :key="a.id"
        class="flex items-center gap-1.5 rounded-full border border-zinc-300 px-2.5 py-0.5 text-xs dark:border-zinc-700"
      >
        <button class="hover:underline" :title="`Download (${fmtSize(a.size)})`" @click="download(a)">
          {{ a.name }}
        </button>
        <button v-if="!readonly" class="text-zinc-400 hover:text-red-500" title="Remove" @click="removeAttachment(a)">
          ✕
        </button>
      </span>
    </div>

    <TabsRoot v-model="tab" class="flex min-h-0 grow flex-col">
      <TabsList class="mb-2 flex w-fit gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900">
        <TabsTrigger
          v-for="t in ['write', 'preview']"
          :key="t"
          :value="t"
          class="rounded-md px-3 py-1 text-sm capitalize text-zinc-500 data-[state=active]:bg-white data-[state=active]:text-zinc-900 data-[state=active]:shadow dark:data-[state=active]:bg-zinc-700 dark:data-[state=active]:text-zinc-100"
        >
          {{ t }}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="write" class="min-h-0 grow">
        <MarkdownEditor v-model="body" :readonly="readonly" />
      </TabsContent>
      <TabsContent value="preview" class="min-h-0 grow overflow-y-auto">
        <MarkdownView :source="body" :attachments="attachments" />
      </TabsContent>
    </TabsRoot>
  </div>
</template>
