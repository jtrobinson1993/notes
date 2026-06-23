<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session';

const session = useSessionStore();
const router = useRouter();
const error = ref('');
const busy = ref(false);

// Passkey is the default; the password form is an "alternative method" for users
// whose authenticator can't produce the PRF output (e.g. Firefox on Linux).
const mode = ref<'passkey' | 'password'>('passkey');
const handle = ref('');
const password = ref('');

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

async function loginPassword() {
  error.value = '';
  busy.value = true;
  try {
    await session.loginWithPassword(handle.value.trim(), password.value);
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

    <template v-if="mode === 'passkey'">
      <button
        :disabled="busy"
        class="w-full rounded-lg bg-blue-600 px-4 py-3 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        @click="login"
      >
        {{ busy ? 'Waiting for passkey…' : 'Sign in with passkey' }}
      </button>
      <p v-if="error" class="mt-4 text-sm text-red-600 dark:text-red-400">{{ error }}</p>
      <button
        type="button"
        class="mt-6 text-sm text-zinc-500 underline dark:text-zinc-400"
        @click="mode = 'password'; error = ''"
      >
        Other ways to sign in
      </button>
    </template>

    <!-- Password fallback (set up in Settings → Security). -->
    <form v-else class="space-y-4 text-left" @submit.prevent="loginPassword">
      <div>
        <label class="mb-1 block text-sm font-medium" for="handle">Handle</label>
        <input
          id="handle"
          v-model="handle"
          required
          placeholder="Word#1234"
          autocomplete="username"
          class="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
        />
      </div>
      <div>
        <label class="mb-1 block text-sm font-medium" for="password">Password</label>
        <input
          id="password"
          v-model="password"
          type="password"
          required
          autocomplete="current-password"
          class="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
        />
      </div>
      <p v-if="error" class="text-sm text-red-600 dark:text-red-400">{{ error }}</p>
      <button
        :disabled="busy"
        class="w-full rounded-lg bg-blue-600 px-4 py-2.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {{ busy ? 'Signing in…' : 'Sign in with password' }}
      </button>
      <button
        type="button"
        class="block w-full text-center text-sm text-zinc-500 underline dark:text-zinc-400"
        @click="mode = 'passkey'; error = ''"
      >
        Back to passkey sign-in
      </button>
    </form>

    <RouterLink to="/recover" class="mt-6 text-sm text-zinc-500 underline dark:text-zinc-400">
      Lost your passkeys? Use your recovery code
    </RouterLink>
  </div>
</template>
