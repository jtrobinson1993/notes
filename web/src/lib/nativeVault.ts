// Shared native-vault gate state + the D4 layer-A re-lock policy.
//
// The gate state lives here (not inside NativeGate.vue) so anything — the
// idle re-locker below, a manual Lock action, future OS device-lock hooks —
// can flip the app back to the lock wall. Policy setting (per device, stored
// in the vault DB — only readable, and only relevant, while unlocked):
//   relock.policy = 'stay' (default) | 'on-idle'
//   relock.idleMinutes = N (default 15)
// OS device-lock detection (macOS lock notifications / mobile lifecycle) is a
// per-platform follow-up; idle timeout is the portable mechanism.

import { ref } from 'vue';
import { isNative, settingsGet, vaultLock, vaultStatus, vaultUnlockKeychain } from './native';
import { reconnectRelay, stopRelayDelivery } from './nativeRelay';

export type GateState = 'checking' | 'setup' | 'recovery' | 'locked' | 'onboarding' | 'ready';

export const gateState = ref<GateState>(isNative ? 'checking' : 'ready');

/** Device settings that together mark the account as onboarded: a relay to talk
 *  to and the handle it assigned us. Absent on a freshly-created vault. */
const HANDLE_KEY = 'identity.handle';
const RELAY_URL_KEY = 'relay.url';

/** True once this device has an account on a relay (handle + relay URL stored).
 *  Until then, an unlocked vault still needs the onboarding step. */
async function isOnboarded(): Promise<boolean> {
  const [handle, url] = await Promise.all([settingsGet(HANDLE_KEY), settingsGet(RELAY_URL_KEY)]);
  return !!handle && !!url;
}

/** Initial status probe + silent keychain unlock (D3 primary path). */
export async function initGate(): Promise<void> {
  if (!isNative) {
    gateState.value = 'ready';
    return;
  }
  const status = await vaultStatus();
  if (status === 'uninitialized') {
    gateState.value = 'setup';
  } else if (status === 'locked') {
    try {
      await vaultUnlockKeychain();
      markUnlocked();
    } catch {
      gateState.value = 'locked';
    }
  } else {
    markUnlocked();
  }
}

/** Call after any successful unlock/create: opens the gate + arms re-lock, and
 *  (native) reconnects the relay so live delivery resumes after a cold start.
 *  A native vault with no relay account yet routes to the onboarding step
 *  instead of straight to 'ready'. */
export function markUnlocked(): void {
  void openGate();
}

async function openGate(): Promise<void> {
  if (isNative && !(await isOnboarded())) {
    gateState.value = 'onboarding';
    return;
  }
  gateState.value = 'ready';
  void applyRelockPolicy();
  void reconnectRelay();
}

/** Call after onboarding registers an account (handle + relay URL now stored):
 *  open the gate for real. The relay session is already live from registration,
 *  so reconnectRelay just (re)starts the JS mail listener. */
export function markOnboarded(): void {
  gateState.value = 'ready';
  void applyRelockPolicy();
  void reconnectRelay();
}

/** Lock the core vault and drop back to the lock wall. */
export async function lockVault(): Promise<void> {
  teardownIdleRelock();
  // Stop the mail listener: while locked the MK is gone, so drains (which open
  // envelopes with the MK-derived sealing key) would only fail. reconnectRelay
  // on the next unlock restarts it. The Rust WS task keeps running by design.
  stopRelayDelivery();
  await vaultLock();
  gateState.value = 'locked';
}

// ---- idle re-lock ----

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'pointermove', 'wheel'] as const;

let idleTimer: ReturnType<typeof setTimeout> | null = null;
let idleMs = 0;
let listening = false;

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void lockVault(), idleMs);
}

function onActivity(): void {
  resetIdleTimer();
}

export async function applyRelockPolicy(): Promise<void> {
  if (!isNative) return;
  teardownIdleRelock();
  if (gateState.value !== 'ready') return;
  const policy = (await settingsGet('relock.policy')) ?? 'stay';
  if (policy !== 'on-idle') return;
  const minutes = Number((await settingsGet('relock.idleMinutes')) ?? '') || 15;
  idleMs = minutes * 60_000;
  for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, onActivity, { passive: true });
  listening = true;
  resetIdleTimer();
}

export function teardownIdleRelock(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (listening) {
    for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onActivity);
    listening = false;
  }
}
