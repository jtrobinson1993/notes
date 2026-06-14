<script setup lang="ts">
import { computed } from 'vue';

// Default profile image: a colored circle with the first letter of the display
// name. Size/typography come from classes the parent applies (h-/w-/text-).
const props = defineProps<{ name: string; seed?: string }>();

// Fixed palette; pick deterministically from the seed (e.g. userId) so a user
// keeps the same color across renders and sessions.
const PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#10b981', '#14b8a6',
  '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef', '#ec4899',
];
const bg = computed(() => {
  const s = props.seed || props.name || '?';
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
});
const letter = computed(() => (props.name.trim()[0] ?? '?').toUpperCase());
</script>

<template>
  <span
    class="flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white"
    :style="{ backgroundColor: bg }"
  >{{ letter }}</span>
</template>
