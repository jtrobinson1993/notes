<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session';
import { api } from '../lib/api';
import RecoveryCodeCard from './RecoveryCodeCard.vue';

const props = defineProps<{ inviteToken?: string; title: string; subtitle: string }>();

const session = useSessionStore();
const router = useRouter();

const username = ref('');
const displayName = ref('');
const error = ref('');
const busy = ref(false);
const step = ref<'form' | 'recovery'>('form');
const recoveryCode = ref('');
const confirmed = ref(false);

async function submit() {
  error.value = '';
  busy.value = true;
  try {
    const { credentialId, prf } = await session.register(username.value.trim(), props.inviteToken);
    recoveryCode.value = await session.setupKeys(credentialId, prf);
    // Persist the display name now that we're authenticated — this is the only
    // name other users ever see (the username stays private). Don't let a hiccup
    // here strand a just-created account; it can also be changed in Settings.
    try {
      await api.profileSet({ displayName: displayName.value.trim() });
    } catch {
      /* non-fatal — account exists; name editable in Settings → Profile */
    }
    step.value = 'recovery';
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'registration failed';
  } finally {
    busy.value = false;
  }
}

function finish() {
  router.push('/');
}
</script>

<template>
  <div class="mx-auto flex min-h-full max-w-md flex-col justify-center p-6">
    <h1 class="mb-1 text-2xl font-bold">{{ title }}</h1>
    <p class="mb-6 text-zinc-500 dark:text-zinc-400">{{ subtitle }}</p>

    <form v-if="step === 'form'" class="space-y-4" @submit.prevent="submit">
      <div>
        <label class="mb-1 block text-sm font-medium" for="username">Username</label>
        <input
          id="username"
          v-model="username"
          required
          minlength="3"
          maxlength="32"
          pattern="[A-Za-z0-9_\-]+"
          autocomplete="username"
          class="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
        />
        <p class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Used to sign in; never shown to other users.</p>
      </div>
      <div>
        <label class="mb-1 block text-sm font-medium" for="displayName">Display name</label>
        <input
          id="displayName"
          v-model="displayName"
          required
          maxlength="50"
          autocomplete="nickname"
          class="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
        />
        <p class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">The name your friends will see. You can change it later.</p>
      </div>
      <p class="text-sm text-zinc-500 dark:text-zinc-400">
        You'll sign in with a <strong>passkey</strong> — no password. Your browser or password
        manager will prompt you to create one. Notes are end-to-end encrypted; the server can
        never read them.
      </p>
      <p v-if="error" class="text-sm text-red-600 dark:text-red-400">{{ error }}</p>
      <button
        :disabled="busy"
        class="w-full rounded-lg bg-blue-600 px-4 py-2.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {{ busy ? 'Setting up…' : 'Create account with passkey' }}
      </button>
    </form>

    <div v-else class="space-y-4">
      <RecoveryCodeCard :code="recoveryCode" />
      <label class="flex items-start gap-2 text-sm">
        <input v-model="confirmed" type="checkbox" class="mt-0.5" />
        <span>I saved my recovery code somewhere safe.</span>
      </label>
      <button
        :disabled="!confirmed"
        class="w-full rounded-lg bg-blue-600 px-4 py-2.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        @click="finish"
      >
        Open my notes
      </button>
    </div>
  </div>
</template>
