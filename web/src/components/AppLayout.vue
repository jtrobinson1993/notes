<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session';
import { useNotesStore } from '../stores/notes';

const session = useSessionStore();
const notes = useNotesStore();
const router = useRouter();
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

async function logout() {
  await session.logout();
  notes.reset();
  router.push('/login');
}
</script>

<template>
  <div class="flex h-full flex-col">
    <header class="flex items-center gap-3 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
      <RouterLink to="/" class="font-bold">{{ session.appName }}</RouterLink>
      <span v-if="notes.syncing" class="text-xs text-zinc-400">syncing…</span>
      <span v-else-if="notes.syncError" class="text-xs text-amber-500" :title="notes.syncError">offline</span>
      <div class="grow" />
      <button
        v-if="session.unlocked"
        class="rounded-lg px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        title="Lock now"
        @click="session.lock()"
      >
        Lock
      </button>
      <RouterLink
        to="/settings"
        class="rounded-lg px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        Settings
      </RouterLink>
      <button
        class="rounded-lg px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        @click="logout"
      >
        Sign out
      </button>
    </header>

    <main class="relative min-h-0 grow">
      <div
        v-if="!session.unlocked"
        class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-zinc-50/95 p-6 backdrop-blur dark:bg-zinc-950/95"
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
  </div>
</template>
