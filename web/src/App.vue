<script setup lang="ts">
import { watch } from 'vue';
import { useSessionStore } from './stores/session';
import { useNotesStore } from './stores/notes';
import { startChat, stopChat } from './stores/chat';
import { useVoiceStore } from './stores/voice';

const session = useSessionStore();
const notes = useNotesStore();
const voice = useVoiceStore();

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
      voice.init(); // subscribe to voice WS events (idempotent)
    } else {
      notes.reset();
      void voice.leave(); // never let a call outlive the master key
      stopChat();
    }
  },
  { immediate: true },
);
</script>

<template>
  <RouterView />
</template>
