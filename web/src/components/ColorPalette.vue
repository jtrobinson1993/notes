<script setup lang="ts">
import { ref } from 'vue';
import { customCss, PRESET_COLORS, presetCss } from '../lib/editor/palette';

// Shared color palette: brand presets plus a custom light/dark pair. Emits
// theme-aware CSS values (var(--brand-*) or light-dark(...)).
defineProps<{ removable?: boolean; removeLabel?: string }>();
const emit = defineEmits<{ pick: [css: string]; remove: [] }>();

const customLight = ref('#dc2626');
const customDark = ref('#f87171');
</script>

<template>
  <div>
    <div class="mb-2 grid grid-cols-4 gap-1.5">
      <button
        v-for="p in PRESET_COLORS"
        :key="p.name"
        :title="p.name"
        class="h-7 w-7 rounded-full border border-zinc-300 hover:scale-110 dark:border-zinc-600"
        :style="{ background: presetCss(p) }"
        @click="emit('pick', presetCss(p))"
      />
    </div>
    <div class="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
      <label class="flex items-center gap-1">☀<input v-model="customLight" type="color" class="h-6 w-7 cursor-pointer" /></label>
      <label class="flex items-center gap-1">☾<input v-model="customDark" type="color" class="h-6 w-7 cursor-pointer" /></label>
      <button class="grow rounded border border-zinc-300 px-1 py-0.5 hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-700" @click="emit('pick', customCss(customLight, customDark))">
        Apply
      </button>
    </div>
    <button
      v-if="removable"
      class="mt-1.5 w-full rounded border border-zinc-300 px-1 py-0.5 text-xs text-zinc-500 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-400 dark:hover:bg-zinc-700"
      @click="emit('remove')"
    >
      {{ removeLabel ?? 'Remove color' }}
    </button>
  </div>
</template>
