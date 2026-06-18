<script setup lang="ts">
import { ref } from 'vue';
import { useSessionStore } from '../stores/session';
import AppSidebar from './AppSidebar.vue';
import CallPanel from './CallPanel.vue';

const session = useSessionStore();
const unlockError = ref('');
const unlocking = ref(false);

async function unlock() {
  unlockError.value = '';
  unlocking.value = true;
  try {
    const result = await session.loginWithPasskey();
    if (result !== 'ok') unlockError.value = 'Could not unlock with this passkey.';
  } catch (e) {
    unlockError.value = e instanceof Error ? e.message : 'unlock failed';
  } finally {
    unlocking.value = false;
  }
}
</script>

<template>
  <div class="flex h-full overflow-hidden">
    <AppSidebar v-if="session.loggedIn" />
    <main class="relative min-h-0 min-w-0 grow overflow-y-auto">
      <div
        v-if="!session.unlocked"
        class="absolute inset-0 z-nav flex flex-col items-center justify-center gap-4 bg-zinc-50/95 p-6 backdrop-blur dark:bg-zinc-950/95"
      >
        <p class="text-lg font-semibold">Locked</p>
        <p class="max-w-sm text-center text-sm text-zinc-500 dark:text-zinc-400">
          Your notes are encrypted. Use your passkey to unlock them.
        </p>
        <button
          :disabled="unlocking"
          class="rounded-lg bg-blue-600 px-5 py-2.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          @click="unlock"
        >
          {{ unlocking ? 'Waiting for passkey…' : 'Unlock with passkey' }}
        </button>
        <p v-if="unlockError" class="max-w-sm text-center text-sm text-red-600 dark:text-red-400">{{ unlockError }}</p>
      </div>
      <slot />
    </main>
    <CallPanel v-if="session.loggedIn" />
  </div>
</template>
