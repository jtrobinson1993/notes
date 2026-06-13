<script setup lang="ts">
import { watch } from 'vue';
import { useSessionStore } from './stores/session';
import { useNotesStore } from './stores/notes';
import { startChat, stopChat } from './stores/chat';

const session = useSessionStore();
const notes = useNotesStore();

for (const event of ['pointerdown', 'keydown', 'wheel'] as const) {
  window.addEventListener(event, () => session.touch(), { passive: true });
}

// Chat (and decrypted notes) must not outlive the master key: connect the chat
// socket when the session unlocks, tear it down on lock/logout.
watch(
  () => session.unlocked,
  (unlocked) => {
    if (unlocked) {
      startChat();
    } else {
      notes.reset();
      stopChat();
    }
  },
  { immediate: true },
);
</script>

<template>
  <RouterView />
</template>
