<script setup lang="ts">
// Native-shell vault wall (UI-3): blocks the app until the local vault is
// created/unlocked. In the browser (isNative false) it slots straight
// through. Flow: uninitialized → password setup → recovery-code display →
// ready; locked → silent keychain attempt → password/recovery fallback.
import { onMounted, ref } from 'vue';
import {
  isNative,
  vaultCreate,
  vaultStatus,
  vaultUnlock,
  vaultUnlockKeychain,
  vaultUnlockRecovery,
} from '../lib/native';

type GateState = 'checking' | 'setup' | 'recovery' | 'locked' | 'ready';

const state = ref<GateState>(isNative ? 'checking' : 'ready');
const password = ref('');
const confirm = ref('');
const recoveryInput = ref('');
const recoveryCode = ref('');
const useRecovery = ref(false);
const error = ref('');
const busy = ref(false);

const MIN_PASSWORD = 16; // matches the web client's enforced minimum

onMounted(async () => {
  if (!isNative) return;
  const status = await vaultStatus();
  if (status === 'uninitialized') {
    state.value = 'setup';
  } else if (status === 'locked') {
    // Primary path (D3): OS keychain, no prompt. Fall back to the form.
    try {
      await vaultUnlockKeychain();
      state.value = 'ready';
    } catch {
      state.value = 'locked';
    }
  } else {
    state.value = 'ready';
  }
});

async function createVault() {
  error.value = '';
  if (password.value.length < MIN_PASSWORD) {
    error.value = `Password must be at least ${MIN_PASSWORD} characters.`;
    return;
  }
  if (password.value !== confirm.value) {
    error.value = 'Passwords do not match.';
    return;
  }
  busy.value = true;
  try {
    recoveryCode.value = await vaultCreate(password.value);
    password.value = '';
    confirm.value = '';
    state.value = 'recovery';
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

async function unlock() {
  error.value = '';
  busy.value = true;
  try {
    if (useRecovery.value) await vaultUnlockRecovery(recoveryInput.value);
    else await vaultUnlock(password.value);
    password.value = '';
    recoveryInput.value = '';
    state.value = 'ready';
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

function confirmRecoverySaved() {
  recoveryCode.value = '';
  state.value = 'ready';
}
</script>

<template>
  <slot v-if="state === 'ready'" />
  <div v-else class="flex h-full items-center justify-center p-6">
    <div class="w-full max-w-sm space-y-4">
      <template v-if="state === 'setup'">
        <h1 class="text-xl font-semibold">Set up this device</h1>
        <p class="text-sm opacity-70">
          Your data is stored encrypted on this device. Choose the password
          that protects it — you'll also get a recovery code.
        </p>
        <form class="space-y-3" @submit.prevent="createVault">
          <input
            v-model="password"
            type="password"
            autocomplete="new-password"
            placeholder="Password (min 16 characters)"
            class="w-full rounded border border-neutral-500/40 bg-transparent px-3 py-2"
          />
          <input
            v-model="confirm"
            type="password"
            autocomplete="new-password"
            placeholder="Confirm password"
            class="w-full rounded border border-neutral-500/40 bg-transparent px-3 py-2"
          />
          <button
            type="submit"
            :disabled="busy"
            class="w-full rounded bg-blue-600 px-3 py-2 font-medium text-white disabled:opacity-50"
          >
            {{ busy ? 'Creating…' : 'Create vault' }}
          </button>
        </form>
      </template>

      <template v-else-if="state === 'recovery'">
        <h1 class="text-xl font-semibold">Your recovery code</h1>
        <p class="text-sm opacity-70">
          This is the only way back in if you lose this device's password and
          keychain. Store it somewhere safe — it is shown only once.
        </p>
        <p
          data-testid="recovery-code"
          class="select-all rounded border border-neutral-500/40 p-3 text-center font-mono text-sm tracking-wide"
        >
          {{ recoveryCode }}
        </p>
        <button
          class="w-full rounded bg-blue-600 px-3 py-2 font-medium text-white"
          @click="confirmRecoverySaved"
        >
          I saved my recovery code
        </button>
      </template>

      <template v-else-if="state === 'locked'">
        <h1 class="text-xl font-semibold">Unlock</h1>
        <form class="space-y-3" @submit.prevent="unlock">
          <input
            v-if="!useRecovery"
            v-model="password"
            type="password"
            autocomplete="current-password"
            placeholder="Password"
            class="w-full rounded border border-neutral-500/40 bg-transparent px-3 py-2"
          />
          <input
            v-else
            v-model="recoveryInput"
            type="text"
            autocomplete="off"
            placeholder="Recovery code"
            class="w-full rounded border border-neutral-500/40 bg-transparent px-3 py-2 font-mono"
          />
          <button
            type="submit"
            :disabled="busy"
            class="w-full rounded bg-blue-600 px-3 py-2 font-medium text-white disabled:opacity-50"
          >
            {{ busy ? 'Unlocking…' : 'Unlock' }}
          </button>
        </form>
        <button class="text-sm underline opacity-70" @click="useRecovery = !useRecovery">
          {{ useRecovery ? 'Use password instead' : 'Use recovery code instead' }}
        </button>
      </template>

      <p v-else class="text-center text-sm opacity-70">Unlocking…</p>

      <p v-if="error" class="text-sm text-red-500">{{ error }}</p>
    </div>
  </div>
</template>
