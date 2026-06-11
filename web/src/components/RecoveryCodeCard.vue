<script setup lang="ts">
import { ref } from 'vue';

defineProps<{ code: string }>();
const copied = ref(false);

async function copy(code: string) {
  await navigator.clipboard.writeText(code);
  copied.value = true;
  setTimeout(() => (copied.value = false), 2000);
}
</script>

<template>
  <div class="rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950">
    <p class="mb-2 text-sm font-semibold text-amber-900 dark:text-amber-200">Your recovery code</p>
    <p class="mb-3 text-sm text-amber-800 dark:text-amber-300">
      This is the <strong>only</strong> way back into your notes if you lose all your passkeys.
      Save it somewhere safe (password manager, printed copy). It will not be shown again.
    </p>
    <div class="flex items-center gap-2">
      <code class="grow select-all break-all rounded-lg bg-white px-3 py-2 font-mono text-sm dark:bg-zinc-900">{{ code }}</code>
      <button
        class="shrink-0 rounded-lg bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700"
        @click="copy(code)"
      >
        {{ copied ? 'Copied!' : 'Copy' }}
      </button>
    </div>
  </div>
</template>
