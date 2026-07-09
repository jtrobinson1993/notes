<script setup lang="ts">
// Native-shell vault wall (UI-3): blocks the app until the local vault is
// created/unlocked. In the browser (isNative false) it slots straight
// through. Flow: uninitialized → password setup → recovery-code display →
// ready; locked → silent keychain attempt → password/recovery fallback.
// Gate state is shared via nativeVault.ts so the idle re-locker (D4 layer A)
// and manual Lock actions can flip the app back to this wall.
import { onMounted, ref } from 'vue';
import {
  vaultCreate,
  vaultRestoreFromEscrow,
  vaultUnlock,
  vaultUnlockRecovery,
} from '../lib/native';
import { gateState as state, initGate, markUnlocked } from '../lib/nativeVault';

const password = ref('');
const confirm = ref('');
const recoveryInput = ref('');
const recoveryCode = ref('');
const useRecovery = ref(false);
const error = ref('');
const busy = ref(false);

// "Existing user, new device" restore (D15/D3a): pull the wrapped-MK escrow
// from a relay by handle + account password and rebuild the vault here.
const useRestore = ref(false);
const restoreUrl = ref('');
const restoreHandle = ref('');
const restorePassword = ref('');

const MIN_PASSWORD = 16; // matches the web client's enforced minimum

onMounted(() => void initGate());

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
    markUnlocked();
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

async function restore() {
  error.value = '';
  if (!restoreUrl.value.trim() || !restoreHandle.value.trim() || !restorePassword.value) {
    error.value = 'Relay address, handle, and password are all required.';
    return;
  }
  busy.value = true;
  try {
    await vaultRestoreFromEscrow(
      restoreUrl.value.trim(),
      restoreHandle.value.trim(),
      restorePassword.value,
    );
    restorePassword.value = '';
    // Restore rebuilds identity only; history arrives by pairing/backup later.
    markUnlocked();
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

function confirmRecoverySaved() {
  recoveryCode.value = '';
  markUnlocked();
}
</script>

<template>
  <slot v-if="state === 'ready'" />
  <div v-else class="flex h-full items-center justify-center p-6">
    <div class="w-full max-w-sm space-y-4">
      <template v-if="state === 'setup' && !useRestore">
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
        <button
          class="text-sm underline opacity-70"
          @click="((error = ''), (useRestore = true))"
        >
          Already have an account? Restore on this device
        </button>
      </template>

      <template v-else-if="state === 'setup' && useRestore">
        <h1 class="text-xl font-semibold">Restore this device</h1>
        <p class="text-sm opacity-70">
          Sign in with your handle and account password to restore your identity
          from your relay. Your notes and message history come across when you
          pair an existing device or import a backup.
        </p>
        <form class="space-y-3" @submit.prevent="restore">
          <input
            v-model="restoreUrl"
            type="url"
            autocomplete="off"
            placeholder="Relay address (https://…)"
            class="w-full rounded border border-neutral-500/40 bg-transparent px-3 py-2"
          />
          <input
            v-model="restoreHandle"
            type="text"
            autocomplete="username"
            placeholder="Handle (e.g. Word#1234)"
            class="w-full rounded border border-neutral-500/40 bg-transparent px-3 py-2"
          />
          <input
            v-model="restorePassword"
            type="password"
            autocomplete="current-password"
            placeholder="Account password"
            class="w-full rounded border border-neutral-500/40 bg-transparent px-3 py-2"
          />
          <button
            type="submit"
            :disabled="busy"
            class="w-full rounded bg-blue-600 px-3 py-2 font-medium text-white disabled:opacity-50"
          >
            {{ busy ? 'Restoring…' : 'Restore' }}
          </button>
        </form>
        <button
          class="text-sm underline opacity-70"
          @click="((error = ''), (useRestore = false))"
        >
          Set up a new account instead
        </button>
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
