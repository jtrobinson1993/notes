<script setup lang="ts">
import { ref } from 'vue';
import { useSessionStore } from '../stores/session';
import { isMobile } from '../lib/mobileNav';
import AppSidebar from './AppSidebar.vue';
import MobileCallBar from './MobileCallBar.vue';
import IncomingCallModal from './IncomingCallModal.vue';

const session = useSessionStore();
const unlockError = ref('');
const unlocking = ref(false);

// Passkey is the default unlock; the password form is the fallback for users
// whose account is password-protected (no passkey, or a passkey that can't
// produce the PRF output). The handle is already known from the logged-in
// session, so only the password is needed.
const mode = ref<'passkey' | 'password'>('passkey');
const password = ref('');

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

async function unlockPassword() {
  if (!session.user) return;
  unlockError.value = '';
  unlocking.value = true;
  try {
    await session.loginWithPassword(session.user.handle, password.value);
  } catch (e) {
    unlockError.value = e instanceof Error ? e.message : 'unlock failed';
  } finally {
    unlocking.value = false;
  }
}
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <!-- Mobile: in-call controls as a top bar; the app shrinks below it. -->
    <MobileCallBar v-if="session.loggedIn && isMobile" />
    <div class="flex min-h-0 grow">
    <AppSidebar v-if="session.loggedIn" />
    <main class="relative min-h-0 min-w-0 grow overflow-y-auto">
      <div
        v-if="!session.unlocked"
        class="absolute inset-0 z-nav flex flex-col items-center justify-center gap-4 bg-zinc-50/95 p-6 backdrop-blur dark:bg-zinc-950/95"
      >
        <p class="text-lg font-semibold">Locked</p>
        <template v-if="mode === 'passkey'">
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
          <button
            type="button"
            class="mt-2 text-sm text-zinc-500 underline dark:text-zinc-400"
            @click="mode = 'password'; unlockError = ''"
          >
            Unlock with password instead
          </button>
        </template>

        <!-- Password fallback (set up in Settings → Security). The handle is
             taken from the logged-in session, so only the password is asked. -->
        <form v-else class="w-full max-w-sm space-y-4 text-left" @submit.prevent="unlockPassword">
          <p class="text-center text-sm text-zinc-500 dark:text-zinc-400">
            Enter your password to unlock your encrypted notes.
          </p>
          <div>
            <label class="mb-1 block text-sm font-medium" for="unlock-password">Password</label>
            <input
              id="unlock-password"
              v-model="password"
              type="password"
              required
              autocomplete="current-password"
              class="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </div>
          <p v-if="unlockError" class="text-sm text-red-600 dark:text-red-400">{{ unlockError }}</p>
          <button
            :disabled="unlocking"
            class="w-full rounded-lg bg-blue-600 px-4 py-2.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {{ unlocking ? 'Unlocking…' : 'Unlock with password' }}
          </button>
          <button
            type="button"
            class="block w-full text-center text-sm text-zinc-500 underline dark:text-zinc-400"
            @click="mode = 'passkey'; unlockError = ''"
          >
            Unlock with passkey instead
          </button>
        </form>
      </div>
      <slot />
    </main>
    </div>
    <IncomingCallModal v-if="session.loggedIn" />
  </div>
</template>
