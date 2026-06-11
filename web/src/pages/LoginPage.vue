<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session';

const session = useSessionStore();
const router = useRouter();
const error = ref('');
const busy = ref(false);

async function login() {
  error.value = '';
  busy.value = true;
  try {
    const result = await session.loginWithPasskey();
    if (result === 'no-prf') {
      error.value = 'This passkey does not support the PRF extension needed to decrypt your notes. Sign in from the device/browser where you created the account, then add a PRF-capable passkey in Settings.';
      return;
    }
    router.push('/');
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'sign-in failed';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="mx-auto flex min-h-full max-w-md flex-col justify-center p-6 text-center">
    <h1 class="mb-1 text-3xl font-bold">{{ session.appName }}</h1>
    <p class="mb-8 text-zinc-500 dark:text-zinc-400">End-to-end encrypted notes</p>
    <button
      :disabled="busy"
      class="w-full rounded-lg bg-blue-600 px-4 py-3 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      @click="login"
    >
      {{ busy ? 'Waiting for passkey…' : 'Sign in with passkey' }}
    </button>
    <p v-if="error" class="mt-4 text-sm text-red-600 dark:text-red-400">{{ error }}</p>
    <RouterLink to="/recover" class="mt-6 text-sm text-zinc-500 underline dark:text-zinc-400">
      Lost your passkeys? Use your recovery code
    </RouterLink>
  </div>
</template>
