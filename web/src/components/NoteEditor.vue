<script setup lang="ts">
import { ref, watch } from 'vue';
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'reka-ui';
import { useNotesStore, type DecryptedNote } from '../stores/notes';
import MarkdownView from './MarkdownView.vue';

const props = defineProps<{ note: DecryptedNote }>();
const emit = defineEmits<{ deleted: [] }>();

const notes = useNotesStore();
const title = ref(props.note.payload.title);
const body = ref(props.note.payload.body);
const tagsInput = ref(props.note.payload.tags.join(', '));
const tab = ref('write');
const saveState = ref<'saved' | 'saving' | 'error'>('saved');
let saveTimer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => props.note.id,
  () => {
    if (saveTimer) clearTimeout(saveTimer);
    title.value = props.note.payload.title;
    body.value = props.note.payload.body;
    tagsInput.value = props.note.payload.tags.join(', ');
    saveState.value = 'saved';
  },
);

watch([title, body, tagsInput], () => {
  saveState.value = 'saving';
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 800);
});

async function save() {
  const tags = [...new Set(tagsInput.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))];
  try {
    await notes.save(props.note.id, { title: title.value, body: body.value, tags });
    saveState.value = 'saved';
  } catch {
    saveState.value = 'error';
  }
}

async function remove() {
  if (!confirm('Delete this note?')) return;
  await notes.remove(props.note.id);
  emit('deleted');
}
</script>

<template>
  <div class="flex h-full flex-col p-4">
    <div class="mb-2 flex items-center gap-2">
      <input
        v-model="title"
        placeholder="Untitled"
        class="grow bg-transparent text-xl font-semibold outline-none placeholder:text-zinc-400"
      />
      <span class="text-xs text-zinc-400">
        {{ saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Save failed (offline?)' : 'Saved' }}
      </span>
      <button
        class="rounded-lg px-2 py-1 text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
        @click="remove"
      >
        Delete
      </button>
    </div>

    <input
      v-model="tagsInput"
      placeholder="tags, comma, separated"
      class="mb-3 w-full bg-transparent text-sm text-zinc-500 outline-none placeholder:text-zinc-400 dark:text-zinc-400"
    />

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
        <textarea
          v-model="body"
          placeholder="Write in Markdown…"
          class="h-full w-full resize-none bg-transparent font-mono text-sm leading-relaxed outline-none placeholder:text-zinc-400"
        />
      </TabsContent>
      <TabsContent value="preview" class="min-h-0 grow overflow-y-auto">
        <MarkdownView :source="body" />
      </TabsContent>
    </TabsRoot>
  </div>
</template>
