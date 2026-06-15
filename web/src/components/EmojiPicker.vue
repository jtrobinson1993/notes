<script setup lang="ts">
import { computed, ref } from 'vue';
import { PopoverRoot, PopoverTrigger, PopoverPortal, PopoverContent } from 'reka-ui';
import { searchDefaultEmoji, emojiUrl } from '../lib/emoji';

// Emits the chosen emote's shortcode name; the composer inserts `:name:`.
const emit = defineEmits<{ pick: [string] }>();

const open = ref(false);
const query = ref('');
const results = computed(() => searchDefaultEmoji(query.value));

function choose(name: string) {
  emit('pick', name);
  // Keep open so several can be added in a row (Discord-style).
}
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverTrigger
      title="Emoji"
      class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-300 text-lg hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
    >
      🙂
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
          placeholder="Search emotes…"
          class="mb-2 shrink-0 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-800"
        />
        <div class="min-h-0 grow overflow-y-auto">
          <p v-if="!results.length" class="px-1 py-4 text-center text-xs text-zinc-400">No emotes found.</p>
          <div v-else class="grid grid-cols-7 gap-1">
            <button
              v-for="e in results"
              :key="e.name"
              :title="`:${e.name}:`"
              class="flex aspect-square items-center justify-center rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
              @click="choose(e.name)"
            >
              <img :src="emojiUrl(e.file)" :alt="`:${e.name}:`" class="max-h-7 max-w-7" loading="lazy" />
            </button>
          </div>
        </div>
        <p class="shrink-0 pt-1 text-center text-[10px] text-zinc-400">Top emotes via 7TV</p>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
