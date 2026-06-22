<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session';
import RecoveryCodeCard from '../components/RecoveryCodeCard.vue';

const session = useSessionStore();
const router = useRouter();

const handle = ref('');
const code = ref('');
const error = ref('');
const busy = ref(false);
const newCode = ref('');
const confirmed = ref(false);

async function recover() {
  error.value = '';
  busy.value = true;
  try {
    newCode.value = await session.recover(handle.value.trim(), code.value);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'recovery failed';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="mx-auto flex min-h-full max-w-md flex-col justify-center p-6">
    <h1 class="mb-1 text-2xl font-bold">Account recovery</h1>

    <template v-if="!newCode">
      <p class="mb-6 text-zinc-500 dark:text-zinc-400">
        Enter your recovery code. You'll register a new passkey, and a new recovery code will be
        issued (the old one stops working).
      </p>
      <form class="space-y-4" @submit.prevent="recover">
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
          <p class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Your public handle, e.g. <span class="font-mono">Word#1234</span>.</p>
        </div>
        <div>
          <label class="mb-1 block text-sm font-medium" for="code">Recovery code</label>
          <input
            id="code"
            v-model="code"
            required
            placeholder="ABCD-EFGH-…"
            class="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>
        <p v-if="error" class="text-sm text-red-600 dark:text-red-400">{{ error }}</p>
        <button
          :disabled="busy"
          class="w-full rounded-lg bg-blue-600 px-4 py-2.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {{ busy ? 'Recovering…' : 'Recover account' }}
        </button>
      </form>
    </template>

    <div v-else class="space-y-4">
      <p class="text-sm text-green-700 dark:text-green-400">
        Recovery complete — a new passkey was registered on this device.
      </p>
      <RecoveryCodeCard :code="newCode" />
      <label class="flex items-start gap-2 text-sm">
        <input v-model="confirmed" type="checkbox" class="mt-0.5" />
        <span>I saved my new recovery code somewhere safe.</span>
      </label>
      <button
        :disabled="!confirmed"
        class="w-full rounded-lg bg-blue-600 px-4 py-2.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        @click="router.push('/')"
      >
        Open my notes
      </button>
    </div>
  </div>
</template>
