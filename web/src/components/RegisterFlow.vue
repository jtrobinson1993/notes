<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session';
import { useProfileStore } from '../stores/profile';
import { api } from '../lib/api';
import RecoveryCodeCard from './RecoveryCodeCard.vue';

const props = defineProps<{ inviteToken?: string; title: string; subtitle: string }>();

const session = useSessionStore();
const profile = useProfileStore();
const router = useRouter();

const username = ref('');
const displayName = ref('');
const error = ref('');
const busy = ref(false);
const step = ref<'form' | 'handle' | 'recovery'>('form');
const recoveryCode = ref('');
const confirmed = ref(false);

// Public handle pick (Word#1234): the account is auto-assigned one; the user can
// pick a different one from a few options here or later in Settings.
const handle = ref('');
const handleOptions = ref<string[]>([]);
const handleBusy = ref(false);

async function submit() {
  error.value = '';
  busy.value = true;
  try {
    const { credentialId, prf } = await session.register(username.value.trim(), props.inviteToken);
    recoveryCode.value = await session.setupKeys(credentialId, prf);
    // Encrypt the display name into the profile (E2EE; the server can't read it).
    // The handle is the only name the server sees. Don't strand a just-created
    // account on a hiccup — both are editable in Settings.
    try {
      await profile.save({ displayName: displayName.value.trim() });
    } catch {
      /* non-fatal — account exists; name editable in Settings → Profile */
    }
    try {
      handle.value = (await api.profileGet()).handle;
      handleOptions.value = (await api.handleOptions()).options;
    } catch {
      /* non-fatal — handle already assigned; changeable in Settings */
    }
    step.value = 'handle';
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'registration failed';
  } finally {
    busy.value = false;
  }
}

async function regenerate() {
  handleBusy.value = true;
  try {
    handleOptions.value = (await api.handleOptions()).options;
  } finally {
    handleBusy.value = false;
  }
}

async function pickHandle(h: string) {
  handleBusy.value = true;
  try {
    handle.value = (await api.handleSet(h)).handle;
    step.value = 'recovery';
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'could not set handle';
  } finally {
    handleBusy.value = false;
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
        <p class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">The name everyone in your chats will see, including people you aren't friends with</p>
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

    <!-- Pick a public handle (the name non-contacts and the server see). -->
    <div v-else-if="step === 'handle'" class="space-y-4">
      <div>
        <p class="text-sm font-medium">Pick your handle</p>
        <p class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          This is the public name people who aren't your contacts (and the server) see. Your
          <strong>display name is encrypted</strong> and shown only to contacts. You can change this later.
        </p>
      </div>
      <p class="text-sm text-zinc-500 dark:text-zinc-400">
        Current: <span class="font-mono">{{ handle }}</span>
      </p>
      <div class="flex flex-wrap gap-2">
        <button
          v-for="opt in handleOptions"
          :key="opt"
          type="button"
          :disabled="handleBusy"
          class="rounded-lg border border-zinc-300 px-3 py-1.5 font-mono text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          @click="pickHandle(opt)"
        >
          {{ opt }}
        </button>
      </div>
      <div class="flex items-center gap-3">
        <button
          type="button"
          :disabled="handleBusy"
          class="text-sm text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
          @click="regenerate"
        >
          Show other options
        </button>
        <button
          type="button"
          class="ml-auto rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          @click="step = 'recovery'"
        >
          Keep {{ handle }}
        </button>
      </div>
    </div>

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
