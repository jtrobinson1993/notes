<script setup lang="ts">
import { ref, watch } from 'vue';
import { PopoverRoot, PopoverTrigger, PopoverPortal, PopoverContent } from 'reka-ui';
import type { GifRef, GifSearchResult } from '@notes/shared';
import { api, ApiError } from '../lib/api';

const emit = defineEmits<{ pick: [GifRef] }>();

const open = ref(false);
const query = ref('');
const results = ref<GifSearchResult[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

let seq = 0;
let debounce: ReturnType<typeof setTimeout> | undefined;

async function run(q: string) {
  const mine = ++seq;
  loading.value = true;
  error.value = null;
  try {
    const res = q.trim() ? await api.gifSearch(q.trim()) : await api.gifTrending();
    if (mine !== seq) return; // a newer query superseded this one
    results.value = res.results;
  } catch (e) {
    if (mine !== seq) return;
    results.value = [];
    error.value =
      e instanceof ApiError && e.status === 503 ? 'GIF search isn’t configured on this server.' : 'Couldn’t load GIFs.';
  } finally {
    if (mine === seq) loading.value = false;
  }
}

watch(query, (q) => {
  clearTimeout(debounce);
  debounce = setTimeout(() => void run(q), 250);
});

// Load trending the first time the picker opens.
watch(open, (isOpen) => {
  if (isOpen && results.value.length === 0 && !loading.value) void run(query.value);
});

function choose(r: GifSearchResult) {
  emit('pick', { provider: 'klipy', id: r.id, url: r.url, previewUrl: r.previewUrl, width: r.width, height: r.height, title: r.title });
  open.value = false;
}
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverTrigger
      title="Send a GIF"
      class="flex h-9 shrink-0 items-center rounded-lg border border-zinc-300 px-2 text-xs font-bold text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
    >
      GIF
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        side="top"
        align="end"
        :side-offset="8"
        :collision-padding="8"
        class="z-30 flex h-96 w-80 flex-col rounded-xl border border-zinc-200 bg-white p-2 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
        @open-auto-focus.prevent
      >
        <input
          v-model="query"
          type="text"
          placeholder="Search GIFs…"
          class="mb-2 shrink-0 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-800"
        />
        <div class="min-h-0 grow overflow-y-auto">
          <p v-if="error" class="px-1 py-4 text-center text-xs text-zinc-500">{{ error }}</p>
          <p v-else-if="loading && !results.length" class="px-1 py-4 text-center text-xs text-zinc-400">Loading…</p>
          <p v-else-if="!results.length" class="px-1 py-4 text-center text-xs text-zinc-400">No GIFs found.</p>
          <div v-else class="columns-2 gap-2">
            <button
              v-for="r in results"
              :key="r.id"
              class="mb-2 block w-full overflow-hidden rounded-lg ring-blue-500 hover:ring-2"
              @click="choose(r)"
            >
              <img
                :src="r.previewUrl"
                :alt="r.title || 'GIF'"
                :style="{ aspectRatio: `${r.width} / ${r.height}` }"
                class="w-full bg-zinc-100 dark:bg-zinc-800"
                loading="lazy"
              />
            </button>
          </div>
        </div>
        <p class="shrink-0 pt-1 text-center text-[10px] text-zinc-400">Powered by KLIPY</p>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
