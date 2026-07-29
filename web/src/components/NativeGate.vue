<script setup lang="ts">
// Native-shell vault wall (UI-3): blocks the app until the local vault is
// created/unlocked and the account is onboarded. Native is the only shell, so
// there is no browser bypass — the wall always applies.
//
// First run (uninitialized vault) opens on a splash offering Sign up, plus a
// "can't sign in?" explainer; a returning device (locked vault) goes straight to
// Unlock. There is deliberately **no "Log in"**: relay-held escrow was removed
// (spec/roadmap.md § "Escrow — removed"), so nothing on any server can rebuild
// an identity on a fresh device, and device pairing — which will — is not built
// (roadmap D8). Offering a login form that can only ever fail would advertise a
// capability the app does not have and contradict the accepted design constraint
// that total device loss is unrecoverable (spec/security.md). Gate state is
// shared via nativeVault.ts so the idle re-locker (D4 layer A) and manual Lock
// can flip back to this wall.
import { onMounted, ref } from 'vue';
import { vaultCreate, vaultUnlock, vaultUnlockRecovery } from '../lib/native';
import { gateState as state, initGate, markOnboarded, markUnlocked } from '../lib/nativeVault';
import { registerOnRelay, registerViaInvite, type SignupIdentity } from '../lib/nativeInvites';
import { parseInvite } from '../lib/invites';
import { generateHandleOptions } from '@notes/shared';

// Sub-view of the first-run ('setup') flow. `recover` and `displayname` overlay
// any auth screen (reachable across gate states); the rest key off `state`.
type View = 'welcome' | 'signup' | 'recover' | 'displayname';
const view = ref<View>('welcome');

// Signup identity: pick a handle from generated Word#1234 candidates (never typed
// — the word is always vetted), then a required display name.
const handleOptions = ref<string[]>([]);
const chosenHandle = ref('');
const displayName = ref('');

function rerollHandles() {
  handleOptions.value = generateHandleOptions(4);
  chosenHandle.value = handleOptions.value[0] ?? '';
}
rerollHandles();

const password = ref('');
const confirm = ref('');
const recoveryInput = ref('');
const recoveryCode = ref('');
const useRecovery = ref(false);
const error = ref('');
const busy = ref(false);

// Onboarding (post-unlock, pre-'ready'): create the relay account. Default path
// is redeeming a friend invite; a relay can also be joined by address + an
// optional operator registration code (or nothing, for a public relay).
const inviteInput = ref('');
const relayUrlInput = ref('');
const relayCodeInput = ref('');
const usePublicRelay = ref(false);

const MIN_PASSWORD = 16; // matches the web client's enforced minimum

onMounted(() => void initGate());

/** Return to the splash from any sub-view, clearing transient state. */
function goWelcome() {
  error.value = '';
  view.value = 'welcome';
}

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

function confirmRecoverySaved() {
  recoveryCode.value = '';
  // Signup continues: choose a required display name before onboarding.
  view.value = 'displayname';
}

function submitDisplayName() {
  error.value = '';
  if (!displayName.value.trim()) {
    error.value = 'Enter a display name (at least 1 character).';
    return;
  }
  // Identity is now chosen (handle + display name); open the gate → onboarding,
  // where register claims the handle and we persist the display name.
  view.value = 'welcome';
  markUnlocked();
}

/** The identity picked in the signup wizard, passed to register at onboarding. */
function signupIdentity(): SignupIdentity {
  return { handle: chosenHandle.value || undefined, displayName: displayName.value.trim() || undefined };
}

/** A friend invite is a self-describing blob (it parses); a bare operator
 *  registration code is not. */
function isFriendInvite(s: string): boolean {
  try {
    parseInvite(s);
    return true;
  } catch {
    return false;
  }
}

async function onboardWithInvite() {
  error.value = '';
  const val = inviteInput.value.trim();
  if (!val) {
    error.value = 'Paste the invite a friend sent you.';
    return;
  }
  // If it isn't a friend-invite blob, it's almost certainly a relay registration
  // code — switch to the relay-address path with it pre-filled instead of erroring
  // (the code alone has no relay address, so it can't be used here).
  if (!isFriendInvite(val)) {
    relayCodeInput.value = val;
    inviteInput.value = '';
    usePublicRelay.value = true;
    return;
  }
  busy.value = true;
  try {
    await registerViaInvite(val, signupIdentity());
    inviteInput.value = '';
    markOnboarded();
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

async function onboardOnRelay() {
  error.value = '';
  if (!relayUrlInput.value.trim()) {
    error.value = 'Enter the relay address.';
    return;
  }
  busy.value = true;
  try {
    await registerOnRelay(relayUrlInput.value.trim(), relayCodeInput.value, signupIdentity());
    relayUrlInput.value = '';
    relayCodeInput.value = '';
    markOnboarded();
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

const inputClass =
  'w-full rounded border border-neutral-500/40 bg-transparent px-3 py-2';
const primaryBtn =
  'w-full rounded bg-blue-600 px-3 py-2 font-medium text-white disabled:opacity-50';
const linkBtn = 'text-sm underline opacity-70';
</script>

<template>
  <slot v-if="state === 'ready'" />
  <div v-else class="flex h-full items-center justify-center p-6">
    <div class="w-full max-w-sm space-y-4">
      <!-- Recover explainer — reachable from the splash and the lock wall. -->
      <template v-if="view === 'recover'">
        <h1 class="text-xl font-semibold">Recovering your account</h1>
        <p class="text-sm opacity-70">
          Accord never collects your email or any personal information, so there's
          no “email me a reset” — and no way for anyone, including us, to recover
          your account for you.
        </p>
        <p class="text-sm opacity-70">
          Your password and the <strong>recovery code</strong> you saved at signup
          both unlock the vault <em>on a device that still has it</em> — they are
          keys to this device's encrypted data, not credentials a server can check.
          Nothing is stored anywhere else.
        </p>
        <p class="text-sm opacity-70">
          So if you no longer have any device with your account on it, it can't be
          recovered — not by you, not by us, not by the relay operator. You'd create
          a new account.
        </p>
        <!-- First run only: this device holds no vault, so say plainly that an
             existing account cannot be pulled onto it yet (pairing — roadmap D8
             — is the mechanism, and it isn't built). -->
        <p v-if="state === 'setup'" class="text-sm opacity-70">
          This device doesn't have your account on it yet. Moving an account onto a
          new device needs the device you already use to hand it over, and that
          pairing step isn't built yet — for now, keep using the device you have.
        </p>
        <button :class="linkBtn" @click="goWelcome">← Back</button>
      </template>

      <!-- Splash (first run). -->
      <template v-else-if="state === 'setup' && view === 'welcome'">
        <div class="space-y-3 text-center">
          <div
            class="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-600 text-3xl font-bold text-white"
          >
            A
          </div>
          <h1 class="text-2xl font-semibold">Welcome to Accord</h1>
          <p class="text-sm opacity-70">
            Private, end-to-end encrypted notes &amp; chat. Your data is encrypted
            on your device — the relay only ever sees ciphertext.
          </p>
        </div>
        <div class="space-y-3 pt-2">
          <button data-testid="signup" :class="primaryBtn" @click="(error = ''), (view = 'signup')">
            Sign up
          </button>
        </div>
        <div class="text-center">
          <button data-testid="recover" :class="linkBtn" @click="(error = ''), (view = 'recover')">
            Already have an account?
          </button>
        </div>
      </template>

      <!-- Sign up: pick a handle + set the vault password. -->
      <template v-else-if="state === 'setup' && view === 'signup'">
        <button :class="linkBtn" @click="goWelcome">← Back</button>
        <h1 class="text-xl font-semibold">Create your account</h1>
        <p class="text-sm opacity-70">
          Pick your handle and choose the password that protects your encrypted
          data on this device. You'll also get a one-time recovery code.
        </p>
        <form class="space-y-3" @submit.prevent="createVault">
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <span class="text-sm font-medium">Your handle</span>
              <button type="button" :class="linkBtn" @click="rerollHandles">Re-roll</button>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <button
                v-for="opt in handleOptions"
                :key="opt"
                type="button"
                data-testid="handle-option"
                class="rounded border px-3 py-2 text-center font-mono text-sm"
                :class="opt === chosenHandle ? 'border-blue-600 bg-blue-600/10 text-blue-500' : 'border-neutral-500/40'"
                @click="chosenHandle = opt"
              >
                {{ opt }}
              </button>
            </div>
            <p class="text-xs opacity-60">
              Handles are randomly generated — pick one, or re-roll for new options.
            </p>
          </div>
          <input
            v-model="password"
            type="password"
            autocomplete="new-password"
            placeholder="Password (min 16 characters)"
            :class="inputClass"
          />
          <input
            v-model="confirm"
            type="password"
            autocomplete="new-password"
            placeholder="Confirm password"
            :class="inputClass"
          />
          <button type="submit" :disabled="busy" :class="primaryBtn">
            {{ busy ? 'Creating…' : 'Create account' }}
          </button>
        </form>
      </template>

      <!-- Display name step (signup): required, shown to contacts (E2EE). -->
      <template v-else-if="view === 'displayname'">
        <h1 class="text-xl font-semibold">Choose a display name</h1>
        <p class="text-sm opacity-70">
          This is the name your contacts see (end-to-end encrypted — the relay
          never sees it). Your handle <span class="font-mono">{{ chosenHandle }}</span>
          stays your public identifier.
        </p>
        <form class="space-y-3" @submit.prevent="submitDisplayName">
          <input
            v-model="displayName"
            type="text"
            maxlength="64"
            autocomplete="off"
            placeholder="Display name"
            :class="inputClass"
          />
          <button type="submit" :class="primaryBtn">Continue</button>
        </form>
      </template>

      <!-- Recovery code display (right after sign-up). -->
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
        <button class="w-full rounded bg-blue-600 px-3 py-2 font-medium text-white" @click="confirmRecoverySaved">
          I saved my recovery code
        </button>
      </template>

      <!-- Returning device: unlock. -->
      <template v-else-if="state === 'locked'">
        <h1 class="text-xl font-semibold">Unlock</h1>
        <form class="space-y-3" @submit.prevent="unlock">
          <input
            v-if="!useRecovery"
            v-model="password"
            type="password"
            autocomplete="current-password"
            placeholder="Password"
            :class="inputClass"
          />
          <input
            v-else
            v-model="recoveryInput"
            type="text"
            autocomplete="off"
            placeholder="Recovery code"
            :class="`${inputClass} font-mono`"
          />
          <button type="submit" :disabled="busy" :class="primaryBtn">
            {{ busy ? 'Unlocking…' : 'Unlock' }}
          </button>
        </form>
        <button :class="linkBtn" @click="useRecovery = !useRecovery">
          {{ useRecovery ? 'Use password instead' : 'Use recovery code instead' }}
        </button>
        <div>
          <button :class="linkBtn" @click="(error = ''), (view = 'recover')">
            Can't unlock? Recover account
          </button>
        </div>
      </template>

      <!-- Onboarding: friend invite. -->
      <template v-else-if="state === 'onboarding' && !usePublicRelay">
        <h1 class="text-xl font-semibold">Join with an invite</h1>
        <p class="text-sm opacity-70">
          Paste the invite a friend sent you. It creates your account on their
          relay and adds the two of you as friends.
        </p>
        <form class="space-y-3" @submit.prevent="onboardWithInvite">
          <textarea
            v-model="inviteInput"
            rows="3"
            placeholder="Paste your invite"
            :class="`${inputClass} font-mono text-xs`"
          ></textarea>
          <button type="submit" :disabled="busy" :class="primaryBtn">
            {{ busy ? 'Creating account…' : 'Create account' }}
          </button>
        </form>
        <button :class="linkBtn" @click="(error = ''), (usePublicRelay = true)">
          Have a relay address + code instead? Enter them
        </button>
      </template>

      <!-- Onboarding: relay address + optional operator code. -->
      <template v-else-if="state === 'onboarding' && usePublicRelay">
        <h1 class="text-xl font-semibold">Join a relay</h1>
        <p class="text-sm opacity-70">
          Enter a relay's address to create an account. Invite-only relays also
          need a one-time registration code from the operator (leave it blank for
          an open relay).
        </p>
        <form class="space-y-3" @submit.prevent="onboardOnRelay">
          <input
            v-model="relayUrlInput"
            type="url"
            autocomplete="off"
            placeholder="Relay address (https://…)"
            :class="inputClass"
          />
          <input
            v-model="relayCodeInput"
            type="text"
            autocomplete="off"
            placeholder="Registration code (if required)"
            :class="`${inputClass} font-mono text-xs`"
          />
          <button type="submit" :disabled="busy" :class="primaryBtn">
            {{ busy ? 'Creating account…' : 'Create account' }}
          </button>
        </form>
        <button :class="linkBtn" @click="(error = ''), (usePublicRelay = false)">
          Have a friend's invite instead? Use it
        </button>
      </template>

      <p v-else class="text-center text-sm opacity-70">Unlocking…</p>

      <p v-if="error" class="text-sm text-red-500">{{ error }}</p>
    </div>
  </div>
</template>
