<script setup lang="ts">
import { watch } from 'vue';
import { useSessionStore } from './stores/session';
import { useNotesStore } from './stores/notes';

const session = useSessionStore();
const notes = useNotesStore();

for (const event of ['pointerdown', 'keydown', 'wheel'] as const) {
  window.addEventListener(event, () => session.touch(), { passive: true });
}

// Decrypted notes must not outlive the master key.
watch(
  () => session.unlocked,
  (unlocked) => {
    if (!unlocked) notes.reset();
  },
);
</script>

<template>
  <RouterView />
</template>
