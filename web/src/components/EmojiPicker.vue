<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { PopoverRoot, PopoverTrigger, PopoverPortal, PopoverContent } from 'reka-ui';
import type { GifRef, GifSearchResult } from '@notes/shared';
import { api, ApiError } from '../lib/api';
import { searchDefaultEmoji, emojiUrl, resolveEmoji } from '../lib/emoji';
import { loadUnicodeEmoji, searchUnicode, type UnicodeEmoji } from '../lib/emoji/unicode';
import { customEmoji } from '../lib/emoji/custom';
import IconSmile from '~icons/mynaui/smile';
import IconSmileSolid from '~icons/mynaui/smile-solid';

// `pick` inserts text at the composer caret (`:name:` or a unicode char); `gif`
// sends a chosen GIF. GIFs are only offered when the `gifs` prop is set (e.g.
// the composer, not the reaction picker).
const emit = defineEmits<{ pick: [string]; gif: [GifRef] }>();
// `compact` renders a small, borderless trigger for the message hover toolbar.
const props = defineProps<{ compact?: boolean; gifs?: boolean }>();

type Tab = 'emotes' | 'unicode' | 'custom' | 'gifs';
const open = ref(false);
const tab = ref<Tab>('emotes');
const query = ref('');

const emoteResults = computed(() => searchDefaultEmoji(query.value));

const customResults = computed(() => {
  const q = query.value.trim().toLowerCase();
  const items = q ? customEmoji.items.filter((e) => e.name.toLowerCase().includes(q)) : customEmoji.items;
  return items.map((e) => ({ name: e.name, url: resolveEmoji(e.name) }));
});

// Unicode set is lazy-loaded the first time the tab is shown.
const unicodeAll = shallowRef<UnicodeEmoji[] | null>(null);
const unicodeLoading = ref(false);
const unicodeResults = computed(() =>
  unicodeAll.value ? searchUnicode(unicodeAll.value, query.value) : [],
);

async function ensureUnicode() {
  if (unicodeAll.value || unicodeLoading.value) return;
  unicodeLoading.value = true;
  try {
    unicodeAll.value = await loadUnicodeEmoji();
  } finally {
    unicodeLoading.value = false;
  }
}

// --- GIFs (KLIPY, server-proxied) ---
const gifResults = ref<GifSearchResult[]>([]);
const gifLoading = ref(false);
const gifError = ref<string | null>(null);
let gifSeq = 0;
let gifDebounce: ReturnType<typeof setTimeout> | undefined;

async function runGifs(q: string) {
  const mine = ++gifSeq;
  gifLoading.value = true;
  gifError.value = null;
  try {
    const res = q.trim() ? await api.gifSearch(q.trim()) : await api.gifTrending();
    if (mine !== gifSeq) return; // superseded
    gifResults.value = res.results;
  } catch (e) {
    if (mine !== gifSeq) return;
    gifResults.value = [];
    gifError.value =
      e instanceof ApiError && e.status === 503 ? 'GIF search isn’t configured on this server.' : 'Couldn’t load GIFs.';
  } finally {
    if (mine === gifSeq) gifLoading.value = false;
  }
}

watch(query, (q) => {
  if (tab.value !== 'gifs') return;
  clearTimeout(gifDebounce);
  gifDebounce = setTimeout(() => void runGifs(q), 250);
});

watch([open, tab], ([isOpen, t]) => {
  if (!isOpen) return;
  if (t === 'unicode') void ensureUnicode();
  if (t === 'gifs' && gifResults.value.length === 0 && !gifLoading.value) void runGifs(query.value);
});

function chooseGif(r: GifSearchResult) {
  emit('gif', { provider: 'klipy', id: r.id, url: r.url, previewUrl: r.previewUrl, width: r.width, height: r.height, title: r.title });
  open.value = false;
}

const placeholder = computed(() =>
  tab.value === 'gifs' ? 'Search GIFs…' : tab.value === 'emotes' ? 'Search emotes…' : 'Search emoji…',
);
const footer = computed(() =>
  tab.value === 'emotes'
    ? 'Top emotes via 7TV'
    : tab.value === 'unicode'
      ? 'Unicode via emojibase'
      : tab.value === 'gifs'
        ? 'Powered by KLIPY'
        : 'Your custom emoji',
);

const tabClass = (t: Tab) =>
  t === tab.value
    ? 'bg-zinc-100 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
    : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200';
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverTrigger
      title="Emoji & GIFs"
      :class="props.compact
        ? 'flex items-center rounded px-1.5 py-1 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700'
        : 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-200/70 dark:text-zinc-400 dark:hover:bg-zinc-700/70'"
    >
      <IconSmile v-if="props.compact" class="h-4 w-4" />
      <IconSmileSolid v-else class="h-5 w-5" />
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        side="top"
        align="end"
        :side-offset="8"
        :collision-padding="8"
        class="z-popover flex h-96 w-80 flex-col rounded-xl border border-zinc-200 bg-white p-2 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
        @open-auto-focus.prevent
      >
        <div class="mb-2 flex shrink-0 gap-1 text-xs">
          <button class="rounded-md px-2 py-1" :class="tabClass('emotes')" @click="tab = 'emotes'">Emotes</button>
          <button class="rounded-md px-2 py-1" :class="tabClass('unicode')" @click="tab = 'unicode'">Emoji</button>
          <button class="rounded-md px-2 py-1" :class="tabClass('custom')" @click="tab = 'custom'">Custom</button>
          <button v-if="props.gifs" class="rounded-md px-2 py-1" :class="tabClass('gifs')" @click="tab = 'gifs'">GIFs</button>
        </div>
        <input
          v-model="query"
          type="text"
          :placeholder="placeholder"
          class="mb-2 shrink-0 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-800"
        />

        <div class="min-h-0 grow overflow-y-auto">
          <!-- Custom emotes (7TV) -->
          <template v-if="tab === 'emotes'">
            <p v-if="!emoteResults.length" class="px-1 py-4 text-center text-xs text-zinc-400">No emotes found.</p>
            <div v-else class="grid grid-cols-7 gap-1">
              <button
                v-for="e in emoteResults"
                :key="e.name"
                :title="`:${e.name}:`"
                class="flex aspect-square items-center justify-center rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
                @click="emit('pick', `:${e.name}:`)"
              >
                <img :src="emojiUrl(e.file)" :alt="`:${e.name}:`" class="max-h-7 max-w-7" loading="lazy" />
              </button>
            </div>
          </template>

          <!-- Per-user custom (encrypted) emoji -->
          <template v-else-if="tab === 'custom'">
            <p v-if="!customResults.length" class="px-1 py-4 text-center text-xs text-zinc-400">
              No custom emoji yet — add some in Settings.
            </p>
            <div v-else class="grid grid-cols-7 gap-1">
              <button
                v-for="e in customResults"
                :key="e.name"
                :title="`:${e.name}:`"
                class="flex aspect-square items-center justify-center rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
                @click="emit('pick', `:${e.name}:`)"
              >
                <img v-if="e.url" :src="e.url" :alt="`:${e.name}:`" class="max-h-7 max-w-7" loading="lazy" />
              </button>
            </div>
          </template>

          <!-- GIFs (KLIPY) -->
          <template v-else-if="tab === 'gifs'">
            <p v-if="gifError" class="px-1 py-4 text-center text-xs text-zinc-500">{{ gifError }}</p>
            <p v-else-if="gifLoading && !gifResults.length" class="px-1 py-4 text-center text-xs text-zinc-400">Loading…</p>
            <p v-else-if="!gifResults.length" class="px-1 py-4 text-center text-xs text-zinc-400">No GIFs found.</p>
            <div v-else class="columns-2 gap-2">
              <button
                v-for="r in gifResults"
                :key="r.id"
                class="mb-2 block w-full overflow-hidden rounded-lg ring-blue-500 hover:ring-2"
                @click="chooseGif(r)"
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
          </template>

          <!-- Unicode emoji (emojibase) -->
          <template v-else>
            <p v-if="unicodeLoading && !unicodeAll" class="px-1 py-4 text-center text-xs text-zinc-400">Loading…</p>
            <p v-else-if="!unicodeResults.length" class="px-1 py-4 text-center text-xs text-zinc-400">No emoji found.</p>
            <div v-else class="grid grid-cols-8 gap-1">
              <button
                v-for="e in unicodeResults"
                :key="e.unicode"
                :title="e.label"
                class="flex aspect-square items-center justify-center rounded text-xl hover:bg-zinc-100 dark:hover:bg-zinc-800"
                @click="emit('pick', e.unicode)"
              >
                {{ e.unicode }}
              </button>
            </div>
          </template>
        </div>
        <p class="shrink-0 pt-1 text-center text-[10px] text-zinc-400">{{ footer }}</p>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
