<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session';
import { useProfileStore } from '../stores/profile';
import { api, ApiError } from '../lib/api';
import { MIN_PASSWORD_LENGTH } from '../lib/password';
import RecoveryCodeCard from './RecoveryCodeCard.vue';

const props = defineProps<{ inviteToken?: string; title: string; subtitle: string }>();

const session = useSessionStore();
const profile = useProfileStore();
const router = useRouter();

const displayName = ref('');
const error = ref('');
const busy = ref(false);
const step = ref<'form' | 'handle' | 'recovery' | 'name'>('form');
const recoveryCode = ref('');
const confirmed = ref(false);

// Passkey is primary; the password path (with the handle as the login username)
// is revealed via "Other options". The chosen handle lives on the password form
// so a password manager captures it alongside the password.
const method = ref<'passkey' | 'password'>('passkey');
const password = ref('');
const passwordConfirm = ref('');
const signupHandles = ref<string[]>([]);
const selectedHandle = ref('');
const handlesBusy = ref(false);

// Passkey 'handle' step (pick a public handle after registering).
const handle = ref('');
const handleOptions = ref<string[]>([]);
const handleBusy = ref(false);

async function loadSignupHandles() {
  handlesBusy.value = true;
  try {
    const opts = (await api.registerHandleOptions()).options;
    if (opts.length) {
      signupHandles.value = opts;
      selectedHandle.value = opts[0]!;
    }
  } catch {
    /* non-fatal — the user can retry with "Show other handles" */
  } finally {
    handlesBusy.value = false;
  }
}

async function usePassword() {
  error.value = '';
  method.value = 'password';
  if (!selectedHandle.value) await loadSignupHandles();
}

function usePasskey() {
  error.value = '';
  method.value = 'passkey';
}

async function submit() {
  error.value = '';
  if (method.value === 'password') return submitPassword();
  // Passkey signup (unchanged): display name + passkey, then pick a handle.
  busy.value = true;
  try {
    const { credentialId, prf } = await session.register(props.inviteToken);
    recoveryCode.value = await session.setupKeys(credentialId, prf);
    // Encrypt the display name into the profile (E2EE; the server can't read it).
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

async function submitPassword() {
  if (!selectedHandle.value) {
    await loadSignupHandles();
    if (!selectedHandle.value) {
      error.value = 'Could not get a handle — check your connection and try again.';
      return;
    }
  }
  if (password.value.length < MIN_PASSWORD_LENGTH) {
    error.value = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    return;
  }
  if (password.value !== passwordConfirm.value) {
    error.value = 'Passwords do not match.';
    return;
  }
  busy.value = true;
  try {
    recoveryCode.value = await session.registerWithPassword(selectedHandle.value, password.value, props.inviteToken);
    step.value = 'recovery';
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      await loadSignupHandles();
      error.value = 'That handle was just taken — we picked a new one for you. Try again.';
    } else {
      error.value = e instanceof Error ? e.message : 'registration failed';
    }
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

// Passkey flow ends at the recovery step; the password flow then sets a display
// name (after the account already exists).
function afterRecovery() {
  if (method.value === 'password') step.value = 'name';
  else finish();
}

async function finishWithName() {
  busy.value = true;
  try {
    const name = displayName.value.trim();
    if (name) {
      try {
        await profile.save({ displayName: name });
      } catch {
        /* non-fatal — editable in Settings → Profile */
      }
    }
    finish();
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
      <!-- Passkey is the recommended method: display name + passkey. -->
      <template v-if="method === 'passkey'">
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
        <button
          type="button"
          class="w-full text-center text-sm text-zinc-500 hover:underline dark:text-zinc-400"
          @click="usePassword"
        >
          Other options
        </button>
      </template>

      <!-- Password path: for users who can't create a passkey. The handle is the
           login username, shown here so a password manager saves it. -->
      <template v-else>
        <div>
          <label class="mb-1 block text-sm font-medium" for="handle">Username</label>
          <div class="flex items-center gap-2">
            <input
              id="handle"
              name="username"
              :value="selectedHandle"
              readonly
              autocomplete="username"
              class="w-full rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2 font-mono outline-none dark:border-zinc-700 dark:bg-zinc-800"
            />
            <button
              type="button"
              :disabled="handlesBusy"
              class="shrink-0 rounded-lg border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              @click="loadSignupHandles"
            >
              Show other handles
            </button>
          </div>
          <p class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            This is your <strong>username</strong> for signing in. <strong>Save it</strong> — it can't be recovered.
          </p>
        </div>
        <div>
          <label class="mb-1 block text-sm font-medium" for="password">Password</label>
          <input
            id="password"
            v-model="password"
            type="password"
            required
            autocomplete="new-password"
            :minlength="MIN_PASSWORD_LENGTH"
            class="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
          />
          <p class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">At least {{ MIN_PASSWORD_LENGTH }} characters. There is no account recovery — keep your recovery code safe.</p>
        </div>
        <div>
          <label class="mb-1 block text-sm font-medium" for="passwordConfirm">Confirm password</label>
          <input
            id="passwordConfirm"
            v-model="passwordConfirm"
            type="password"
            required
            autocomplete="new-password"
            class="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>
        <p class="text-sm text-zinc-500 dark:text-zinc-400">
          Notes are end-to-end encrypted; the server can never read them. You can add a
          <strong>passkey</strong> later in Settings.
        </p>
        <p v-if="error" class="text-sm text-red-600 dark:text-red-400">{{ error }}</p>
        <button
          :disabled="busy"
          class="w-full rounded-lg bg-blue-600 px-4 py-2.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {{ busy ? 'Creating account…' : 'Create account with password' }}
        </button>
        <button
          type="button"
          class="w-full text-center text-sm text-zinc-500 hover:underline dark:text-zinc-400"
          @click="usePasskey"
        >
          Back to passkey
        </button>
      </template>
    </form>

    <!-- Pick a public handle (passkey flow; the name non-contacts and the server see). -->
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

    <!-- Recovery code (both flows). The password flow also reminds the user of
         their username here, then continues to set a display name. -->
    <div v-else-if="step === 'recovery'" class="space-y-4">
      <div
        v-if="method === 'password'"
        class="rounded-lg border border-blue-300 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-700/60 dark:bg-blue-950/40 dark:text-blue-200"
      >
        Your username is <strong class="font-mono">{{ session.user?.handle }}</strong>. Save it in your
        password manager — you'll need it together with your password to sign in, and it can't be recovered.
      </div>
      <RecoveryCodeCard :code="recoveryCode" />
      <label class="flex items-start gap-2 text-sm">
        <input v-model="confirmed" type="checkbox" class="mt-0.5" />
        <span>I saved my {{ method === 'password' ? 'username and ' : '' }}recovery code somewhere safe.</span>
      </label>
      <button
        :disabled="!confirmed"
        class="w-full rounded-lg bg-blue-600 px-4 py-2.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        @click="afterRecovery"
      >
        {{ method === 'password' ? 'Continue' : 'Open my notes' }}
      </button>
    </div>

    <!-- Display name (password flow only; set after the account exists). -->
    <div v-else class="space-y-4">
      <div>
        <label class="mb-1 block text-sm font-medium" for="displayNameAfter">Display name</label>
        <input
          id="displayNameAfter"
          v-model="displayName"
          maxlength="50"
          autocomplete="nickname"
          class="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
        />
        <p class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">The name everyone in your chats will see, including people you aren't friends with. You can change this later in Settings.</p>
      </div>
      <button
        :disabled="busy"
        class="w-full rounded-lg bg-blue-600 px-4 py-2.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        @click="finishWithName"
      >
        {{ busy ? 'Saving…' : 'Open my notes' }}
      </button>
    </div>
  </div>
</template>
