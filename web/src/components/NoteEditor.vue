<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, type Component } from 'vue';
import { isMobile } from '../lib/mobileNav';
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
import { attachmentCap } from '../lib/attachments';
import { optimizeImages } from '../lib/privacy';
import { clearTagColor, setTagColor, tagColor, tagTextColor } from '../lib/tagColors';
import { useNotesStore, type DecryptedNote } from '../stores/notes';
import { useOrgStore } from '../stores/organization';
import IconFolder from '~icons/mynaui/folder';
import IconX from '~icons/mynaui/x';
import IconChevronLeft from '~icons/mynaui/chevron-left';
import IconPencil from '~icons/mynaui/pencil';
import IconCode from '~icons/mynaui/code';
import IconBookOpen from '~icons/mynaui/book-open';
import ColorPalette from './ColorPalette.vue';
import EmojiInput from './EmojiInput.vue';
import EmojiText from './EmojiText.vue';
import MarkdownEditor from './MarkdownEditor.vue';
import MarkdownView from './MarkdownView.vue';
import ShareDialog from './ShareDialog.vue';
import HistoryDialog from './HistoryDialog.vue';

// `closable` shows a ✕ next to the kebab — used when the editor is opened as an
// overlay over a chat; emits `close` when clicked. `backable` shows a mobile-only
// back chevron at the start of the header (notes page full-screen flow); emits `back`.
const props = defineProps<{ note: DecryptedNote; closable?: boolean; backable?: boolean }>();
const emit = defineEmits<{ deleted: []; close: []; back: [] }>();

const notes = useNotesStore();
const org = useOrgStore();
// The note's folder is personal organization (org store), not part of the note
// payload — so it also applies to notes shared with me.
const folderName = computed(() => {
  const id = org.folderOf(props.note.id);
  return id ? (org.folders.find((f) => f.id === id)?.name ?? null) : null;
});
const title = ref(props.note.payload.title);
const body = ref(props.note.payload.body);
const editor = ref<{ insertText: (s: string) => void } | null>(null);
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
const modes: { value: Mode; label: string; title: string; icon: Component }[] = [
  { value: 'live', label: 'Live', title: 'Live preview — formatting applied as you type', icon: IconPencil },
  { value: 'source', label: 'Source', title: 'Raw Markdown source', icon: IconCode },
  { value: 'reading', label: 'Reading', title: 'Rendered, read-only view', icon: IconBookOpen },
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

// Upload + attach a batch of files. Each file is independent: one failure
// (oversize, network, server reject) must not abort the batch or orphan files
// already uploaded this round. Image markdown is inserted at the caret when
// `atCursor` (paste / drop), else appended to the end (the attach button).
// Shared by the attach button, paste, and drag-and-drop.
async function attachFiles(files: FileList | File[], atCursor = false) {
  const list = Array.from(files);
  if (!list.length) return;
  const failed: string[] = [];
  let added = 0;
  for (const file of list) {
    try {
      let data: Uint8Array = new Uint8Array(await file.arrayBuffer());
      let type = file.type || 'application/octet-stream';
      if (optimizeImages.value) {
        const optimized = await optimizeImage(data, type);
        data = optimized.data;
        type = optimized.type;
      }
      const cap = attachmentCap(type);
      if (data.length + 16 > cap) {
        failed.push(`${file.name} — too large (${fmtSize(data.length)}, max ${fmtSize(cap)})`);
        continue;
      }
      const { ciphertext, key, iv } = await encryptBlob(data);
      const { id } = await api.attachmentUpload(ciphertext);
      attachments.value.push({ id, name: file.name, type, size: data.length, key, iv });
      if (type.startsWith('image/')) {
        const markup = `![${file.name}](attachment:${id})`;
        if (atCursor && editor.value) editor.value.insertText(`${markup}\n`);
        else body.value += `${body.value.endsWith('\n') || !body.value ? '' : '\n\n'}${markup}\n`;
      }
      added++;
    } catch (e) {
      failed.push(`${file.name} — ${e instanceof Error ? e.message : 'upload failed'}`);
    }
  }
  attachError.value = failed.length ? `Couldn't attach: ${failed.join('; ')}` : '';
  if (added) await save();
}

async function attach(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.files?.length) await attachFiles(input.files, false);
  input.value = '';
}

// Paste / drop from the editor: insert images at the caret (the editor already
// moved the caret to the drop point for drops).
function onEditorFiles(files: File[]) {
  void attachFiles(files, true);
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
      <!-- Mobile: back to the notes list (this editor is full-screen). -->
      <button
        v-if="backable && isMobile"
        type="button"
        class="-ml-1 shrink-0 rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
        aria-label="Back to notes"
        @click="emit('back')"
      >
        <IconChevronLeft class="h-5 w-5" />
      </button>
      <EmojiInput
        v-model="title"
        placeholder="Untitled"
        :readonly="readonly"
        wrapper-class="min-w-0 grow"
        input-class="w-full bg-transparent text-xl font-semibold outline-none placeholder:text-zinc-400"
      />
      <span v-if="note.shared" class="shrink-0 rounded-full bg-violet-100 px-2 py-0.5 text-xs text-violet-700 dark:bg-violet-950 dark:text-violet-300">
        {{ note.shared.ownerDisplayName }} · {{ note.shared.access === 'read' ? 'read-only' : 'can edit' }}
      </span>
      <!-- Mode toggle: inline on desktop; a floating control bottom-right on mobile. -->
      <div
        class="flex shrink-0 gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900"
        :class="isMobile ? 'fixed bottom-4 right-4 z-nav shadow-lg' : ''"
      >
        <button
          v-for="m in modes"
          :key="m.value"
          :title="m.title"
          class="flex items-center justify-center rounded-md py-1 text-sm text-zinc-500"
          :class="[mode === m.value ? 'bg-white text-zinc-900 shadow dark:bg-zinc-700 dark:text-zinc-100' : '', isMobile ? 'px-2.5' : 'px-3']"
          @click="mode = m.value"
        >
          <component :is="m.icon" v-if="isMobile" class="h-4 w-4" />
          <template v-else>{{ m.label }}</template>
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
            class="z-popover min-w-44 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
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
      <button
        v-if="closable"
        class="shrink-0 rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        title="Close note"
        aria-label="Close note"
        @click="emit('close')"
      >
        <IconX class="h-5 w-5" />
      </button>
      <input ref="fileInput" type="file" multiple class="hidden" @change="attach" />
      <ShareDialog v-if="isOwner" v-model:open="shareOpen" :note-id="note.id" />
      <HistoryDialog v-if="isOwner" v-model:open="historyOpen" :note-id="note.id" />
    </div>

    <div class="mb-2 flex flex-wrap items-center gap-1.5">
      <!-- Folder (read-only; assign by dragging in the notes/chat tree). -->
      <span
        v-if="folderName"
        class="flex max-w-[10rem] items-center gap-1 rounded-full border border-zinc-300 px-2 py-0.5 text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
        title="Folder"
      >
        <IconFolder class="h-3 w-3 shrink-0" />
        <span class="truncate"><EmojiText :text="folderName" /></span>
      </span>
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
              class="z-popover w-44 rounded-lg border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-800"
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
        ref="editor"
        v-model="body"
        :readonly="readonly"
        :mode="mode"
        :resolve-attachment="resolveAttachment"
        @files="onEditorFiles"
      />
    </div>
  </div>
</template>
