<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  PopoverContent,
  PopoverPortal,
  PopoverRoot,
  PopoverTrigger,
} from 'reka-ui';
import type { AttachmentRef } from '@notes/shared';
import { api } from '../lib/api';
import { decryptBlob, encryptBlob } from '../lib/crypto';
import { optimizeImage } from '../lib/imageOptimize';
import { optimizeImages } from '../lib/privacy';
import { clearTagColor, setTagColor, tagColor, tagTextColor } from '../lib/tagColors';
import { useNotesStore, type DecryptedNote } from '../stores/notes';
import ColorPalette from './ColorPalette.vue';
import MarkdownEditor from './MarkdownEditor.vue';
import MarkdownView from './MarkdownView.vue';
import ShareDialog from './ShareDialog.vue';
import HistoryDialog from './HistoryDialog.vue';

const props = defineProps<{ note: DecryptedNote }>();
const emit = defineEmits<{ deleted: [] }>();

const notes = useNotesStore();
const title = ref(props.note.payload.title);
const body = ref(props.note.payload.body);
const tags = ref<string[]>([...props.note.payload.tags]);
const tagInput = ref('');
const colorTagOpen = ref<string | null>(null);

function pickTagColor(tag: string, css: string) {
  setTagColor(tag, css);
  colorTagOpen.value = null;
}

function resetTagColor(tag: string) {
  clearTagColor(tag);
  colorTagOpen.value = null;
}
const attachments = ref<AttachmentRef[]>(props.note.payload.attachments ?? []);
const saveState = ref<'saved' | 'unsaved' | 'saving' | 'error'>('saved');
const fileInput = ref<HTMLInputElement>();
const shareOpen = ref(false);
const historyOpen = ref(false);
const attachError = ref('');
let saveTimer: ReturnType<typeof setTimeout> | null = null;
// Bumped on every edit (and note switch) so a save that finishes after the
// user has typed again doesn't overwrite the 'unsaved' indicator.
let editGen = 0;

type Mode = 'live' | 'source' | 'reading';
const MODE_KEY = 'notes:editor-mode';
const stored = localStorage.getItem(MODE_KEY);
const mode = ref<Mode>(stored === 'source' || stored === 'reading' ? stored : 'live');
watch(mode, (m) => localStorage.setItem(MODE_KEY, m));
const modes: { value: Mode; label: string; title: string }[] = [
  { value: 'live', label: 'Live', title: 'Live preview — formatting applied as you type' },
  { value: 'source', label: 'Source', title: 'Raw Markdown source' },
  { value: 'reading', label: 'Reading', title: 'Rendered, read-only view' },
];

const readonly = computed(() => props.note.shared?.access === 'read');
const isOwner = computed(() => !props.note.shared);

// Resolve attachment ids to decrypted object URLs for inline rendering in
// the live editor; cached so a widget rebuild doesn't redownload.
const urlCache = new Map<string, Promise<string | null>>();
const objectUrls: string[] = [];

function resolveAttachment(id: string): Promise<string | null> {
  let cached = urlCache.get(id);
  if (!cached) {
    cached = (async () => {
      const ref = attachments.value.find((a) => a.id === id);
      if (!ref) return null;
      try {
        const ct = await api.attachmentDownload(ref.id);
        const data = await decryptBlob(ct, ref.key, ref.iv);
        const url = URL.createObjectURL(new Blob([data as BlobPart], { type: ref.type }));
        objectUrls.push(url);
        return url;
      } catch {
        return null;
      }
    })();
    urlCache.set(id, cached);
  }
  return cached;
}

onBeforeUnmount(() => {
  for (const url of objectUrls) URL.revokeObjectURL(url);
});

watch(
  () => props.note.id,
  () => {
    if (saveTimer) clearTimeout(saveTimer);
    editGen++;
    title.value = props.note.payload.title;
    body.value = props.note.payload.body;
    tags.value = [...props.note.payload.tags];
    attachments.value = props.note.payload.attachments ?? [];
    saveState.value = 'saved';
  },
);

watch([title, body, tags], () => {
  if (readonly.value) return;
  editGen++;
  saveState.value = 'unsaved';
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 800);
});

async function save() {
  const gen = editGen;
  saveState.value = 'saving';
  try {
    await notes.save(props.note.id, {
      title: title.value,
      body: body.value,
      tags: tags.value,
      attachments: attachments.value.length ? attachments.value : undefined,
    });
    if (gen === editGen) saveState.value = notes.pendingCount > 0 ? 'error' : 'saved';
  } catch {
    if (gen === editGen) saveState.value = 'error';
  }
}

// Mirrors the server's MAX_ATTACHMENT_BYTES; the uploaded ciphertext adds a
// 16-byte GCM tag, so we check against the limit minus that.
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

async function attach(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = input.files;
  if (!files) return;
  // Each file is independent: one failure (oversize, network, server reject)
  // must not abort the batch or orphan files already uploaded this round.
  const failed: string[] = [];
  let added = 0;
  for (const file of files) {
    try {
      let data: Uint8Array = new Uint8Array(await file.arrayBuffer());
      let type = file.type || 'application/octet-stream';
      if (optimizeImages.value) {
        const optimized = await optimizeImage(data, type);
        data = optimized.data;
        type = optimized.type;
      }
      if (data.length + 16 > MAX_ATTACHMENT_BYTES) {
        failed.push(`${file.name} — too large (${fmtSize(data.length)}, max ${fmtSize(MAX_ATTACHMENT_BYTES)})`);
        continue;
      }
      const { ciphertext, key, iv } = await encryptBlob(data);
      const { id } = await api.attachmentUpload(ciphertext);
      attachments.value.push({ id, name: file.name, type, size: data.length, key, iv });
      if (type.startsWith('image/')) {
        body.value += `${body.value.endsWith('\n') || !body.value ? '' : '\n\n'}![${file.name}](attachment:${id})\n`;
      }
      added++;
    } catch (e) {
      failed.push(`${file.name} — ${e instanceof Error ? e.message : 'upload failed'}`);
    }
  }
  input.value = '';
  attachError.value = failed.length ? `Couldn't attach: ${failed.join('; ')}` : '';
  if (added) await save();
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

function addTag() {
  const tag = tagInput.value.trim().toLowerCase();
  if (tag && !tags.value.includes(tag)) tags.value = [...tags.value, tag];
  tagInput.value = '';
}

function removeTag(tag: string) {
  tags.value = tags.value.filter((t) => t !== tag);
}

function popLastTag() {
  if (!tagInput.value && tags.value.length) tags.value = tags.value.slice(0, -1);
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
      <div class="flex shrink-0 gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900">
        <button
          v-for="m in modes"
          :key="m.value"
          :title="m.title"
          class="rounded-md px-3 py-1 text-sm text-zinc-500"
          :class="mode === m.value ? 'bg-white text-zinc-900 shadow dark:bg-zinc-700 dark:text-zinc-100' : ''"
          @click="mode = m.value"
        >
          {{ m.label }}
        </button>
      </div>
      <span class="shrink-0 px-1 text-xs text-zinc-400">
        {{ saveState === 'unsaved' ? 'Unsaved' : saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Failed to save' : 'Saved' }}
      </span>
      <DropdownMenuRoot v-if="isOwner || !readonly">
        <DropdownMenuTrigger
          class="shrink-0 rounded-lg px-2.5 py-1 text-lg leading-none text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          aria-label="Note actions"
        >
          ⋮
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent
            align="end"
            :side-offset="4"
            class="z-30 min-w-44 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
          >
            <DropdownMenuItem
              v-if="isOwner"
              class="rounded-md px-3 py-1.5 text-sm text-zinc-700 outline-none data-highlighted:bg-zinc-100 dark:text-zinc-200 dark:data-highlighted:bg-zinc-800"
              @select="shareOpen = true"
            >
              Share
            </DropdownMenuItem>
            <DropdownMenuItem
              v-if="isOwner"
              class="rounded-md px-3 py-1.5 text-sm text-zinc-700 outline-none data-highlighted:bg-zinc-100 dark:text-zinc-200 dark:data-highlighted:bg-zinc-800"
              @select="historyOpen = true"
            >
              History
            </DropdownMenuItem>
            <DropdownMenuItem
              v-if="!readonly"
              class="rounded-md px-3 py-1.5 text-sm text-zinc-700 outline-none data-highlighted:bg-zinc-100 dark:text-zinc-200 dark:data-highlighted:bg-zinc-800"
              @select="fileInput?.click()"
            >
              Attach
            </DropdownMenuItem>
            <DropdownMenuItem
              v-if="isOwner"
              class="rounded-md px-3 py-1.5 text-sm text-red-500 outline-none data-highlighted:bg-red-50 dark:data-highlighted:bg-red-950"
              @select="remove"
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenuRoot>
      <input ref="fileInput" type="file" multiple class="hidden" @change="attach" />
      <ShareDialog v-if="isOwner" v-model:open="shareOpen" :note-id="note.id" />
      <HistoryDialog v-if="isOwner" v-model:open="historyOpen" :note-id="note.id" />
    </div>

    <div class="mb-2 flex flex-wrap items-center gap-1.5">
      <span
        v-for="tag in tags"
        :key="tag"
        class="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
        :style="{ background: tagColor(tag), color: tagTextColor(tagColor(tag)) }"
      >
        <PopoverRoot :open="colorTagOpen === tag" @update:open="colorTagOpen = $event ? tag : null">
          <PopoverTrigger title="Tag color">{{ tag }}</PopoverTrigger>
          <PopoverPortal>
            <PopoverContent
              side="bottom"
              align="start"
              :side-offset="6"
              class="z-30 w-44 rounded-lg border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-800"
            >
              <ColorPalette removable remove-label="Reset color" @pick="pickTagColor(tag, $event)" @remove="resetTagColor(tag)" />
            </PopoverContent>
          </PopoverPortal>
        </PopoverRoot>
        <button
          v-if="!readonly"
          class="-mr-0.5 rounded-full px-0.5 leading-none opacity-70 hover:opacity-100"
          :title="`Remove ${tag}`"
          @click="removeTag(tag)"
        >
          ✕
        </button>
      </span>
      <input
        v-if="!readonly"
        v-model="tagInput"
        placeholder="Add tag…"
        class="min-w-24 grow bg-transparent text-sm text-zinc-500 outline-none placeholder:text-zinc-400 dark:text-zinc-400"
        @keydown.enter.prevent="addTag"
        @keydown.backspace="popLastTag"
        @blur="addTag"
      />
    </div>

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

    <p
      v-if="attachError"
      class="mb-2 rounded-lg bg-red-50 px-3 py-1.5 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400"
    >
      {{ attachError }}
    </p>

    <div v-if="mode === 'reading'" class="min-h-0 grow overflow-y-auto">
      <MarkdownView :source="body" :attachments="attachments" />
    </div>
    <div v-else class="min-h-0 grow">
      <MarkdownEditor
        v-model="body"
        :readonly="readonly"
        :mode="mode"
        :resolve-attachment="resolveAttachment"
      />
    </div>
  </div>
</template>
