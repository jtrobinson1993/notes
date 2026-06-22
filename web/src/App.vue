<script setup lang="ts">
import { watch } from 'vue';
import { useSessionStore } from './stores/session';
import { useNotesStore } from './stores/notes';
import { startChat, stopChat, useChatStore } from './stores/chat';
import { useVoiceStore } from './stores/voice';

const session = useSessionStore();
const notes = useNotesStore();
const voice = useVoiceStore();
const chat = useChatStore();

// Surface total unread in the browser tab title and (when installed) the PWA
// app-icon badge, so new messages are visible without the tab focused.
const baseTitle = document.title || 'notes';
watch(
  () => chat.totalUnread,
  (n) => {
    document.title = n > 0 ? `(${n > 99 ? '99+' : n}) ${baseTitle}` : baseTitle;
    try {
      if (n > 0) void navigator.setAppBadge?.(n);
      else void navigator.clearAppBadge?.();
    } catch {
      /* Badging API unsupported (most browsers outside installed PWAs) */
    }
  },
  { immediate: true },
);

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
  <!-- Inset every page from the device safe areas (one boundary for the whole
       app, incl. pre-auth pages). env() insets are 0 on desktop, so it's inert. -->
  <div class="app-safe h-full">
    <RouterView />
  </div>
</template>
