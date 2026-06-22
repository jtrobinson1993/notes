import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { UserInfo, WrappedKey } from '@notes/shared';
import { api } from '../lib/api';
import { b64, ub64 } from '../lib/b64';
import {
  generateKeyPair,
  generateMasterKey,
  INFO_MK_WRAP,
  INFO_PRIVATE_KEY,
  INFO_RECOVERY_WRAP,
  sha256b64,
  unwrapKey,
  wrapKey,
} from '../lib/crypto';
import { clearCache } from '../lib/idb';
import { deriveRecoveryAuthKey, generateRecoveryCode, parseRecoveryCode } from '../lib/recovery';
import { authenticatePasskey, registerPasskey } from '../lib/webauthn';

const MK_STORAGE_KEY = 'notes:mk';

export const useSessionStore = defineStore('session', () => {
  const ready = ref(false);
  const needsSetup = ref(false);
  const appName = ref('Notes');
  const user = ref<UserInfo | null>(null);
  const hasKeys = ref(false);
  // The master key lives only in memory for the session, mirrored into
  // sessionStorage so an in-tab reload restores it without re-prompting. There
  // is no inactivity auto-lock: the device's own lock screen is the security
  // boundary, and the key is dropped when the tab/app fully closes
  // (sessionStorage is per-tab) or on a manual Lock. It is deliberately never
  // written to persistent storage, which would expose it to XSS at rest.
  const mk = ref<Uint8Array | null>(null);

  const loggedIn = computed(() => user.value !== null);
  const unlocked = computed(() => mk.value !== null);

  function setMk(bytes: Uint8Array | null): void {
    mk.value = bytes;
    if (bytes) sessionStorage.setItem(MK_STORAGE_KEY, b64(bytes));
    else sessionStorage.removeItem(MK_STORAGE_KEY);
  }

  /** Manual lock (the sidebar "Lock now"): drop the key from memory and the
   *  per-tab sessionStorage mirror. */
  function lock(): void {
    setMk(null);
    keyPair = null;
  }

  let keyPair: { privateKey: Uint8Array; publicKey: Uint8Array } | null = null;

  /** Unwrap my X25519 keypair with the master key (cached until lock). */
  async function getKeyPair(): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array }> {
    if (keyPair) return keyPair;
    if (!mk.value) throw new Error('locked');
    const me = await api.me();
    if (!me.wrappedPrivateKey || !me.user.publicKey) throw new Error('keys not set up');
    keyPair = {
      privateKey: await unwrapKey(mk.value, me.wrappedPrivateKey, INFO_PRIVATE_KEY),
      publicKey: ub64(me.user.publicKey),
    };
    return keyPair;
  }

  async function init(): Promise<void> {
    if (ready.value) return;
    try {
      const meta = await api.meta();
      needsSetup.value = meta.needsSetup;
      appName.value = meta.appName;
      const me = await api.me();
      user.value = me.user;
      hasKeys.value = me.hasKeys;
      const stored = sessionStorage.getItem(MK_STORAGE_KEY);
      if (stored) mk.value = ub64(stored);
    } catch {
      // 401 -> not logged in; network error -> handled by pages
    } finally {
      ready.value = true;
    }
  }

  /** Passkey login. Also used to unlock: a fresh assertion yields the PRF
   * output needed to unwrap the master key. */
  async function loginWithPasskey(): Promise<'ok' | 'no-prf' | 'no-wrapped-mk'> {
    const { authId, options } = await api.loginOptions();
    const { response, prf } = await authenticatePasskey(options);
    const result = await api.loginVerify(authId, response);
    user.value = result.user;
    needsSetup.value = false;
    if (!prf) return 'no-prf';
    if (!result.wrappedMk) return 'no-wrapped-mk';
    setMk(await unwrapKey(prf, result.wrappedMk, INFO_MK_WRAP));
    const me = await api.me();
    hasKeys.value = me.hasKeys;
    return 'ok';
  }

  /** Create the account + first passkey (setup or invite signup). */
  async function register(username: string, inviteToken?: string): Promise<{ credentialId: string; prf: Uint8Array | null }> {
    const { regId, options } = await api.registerOptions(username, inviteToken);
    const { response, prf } = await registerPasskey(options);
    const result = await api.registerVerify(regId, response, deviceName());
    user.value = result.user;
    needsSetup.value = false;
    return { credentialId: result.credentialId, prf };
  }

  /** Some authenticators only produce PRF output during assertions, not
   * registration. Fall back to one extra passkey prompt. */
  async function obtainPrf(existing: Uint8Array | null): Promise<Uint8Array> {
    if (existing) return existing;
    const { authId, options } = await api.loginOptions();
    const { response, prf } = await authenticatePasskey(options);
    await api.loginVerify(authId, response);
    if (!prf) throw new Error('This passkey does not support the PRF extension required for encryption. Try a different password manager or device.');
    return prf;
  }

  /** After first registration: create master key, recovery code and keypair,
   * wrap everything and upload. Returns the recovery code for display. */
  async function setupKeys(credentialId: string, prfMaybe: Uint8Array | null): Promise<string> {
    const prf = await obtainPrf(prfMaybe);
    const masterKey = generateMasterKey();
    const recovery = generateRecoveryCode();
    const pair = generateKeyPair();

    const [wrappedMk, wrappedPrivateKey, recoveryWrappedMk, authKey] = await Promise.all([
      wrapKey(prf, masterKey, INFO_MK_WRAP),
      wrapKey(masterKey, pair.privateKey, INFO_PRIVATE_KEY),
      wrapKey(recovery.secret, masterKey, INFO_RECOVERY_WRAP),
      deriveRecoveryAuthKey(recovery.secret),
    ]);
    await api.putKeys({
      publicKey: b64(pair.publicKey),
      wrappedPrivateKey,
      recoveryWrappedMk,
      recoveryAuthHash: await sha256b64(authKey),
    });
    await api.credentialPutWrappedMk(credentialId, wrappedMk);
    hasKeys.value = true;
    setMk(masterKey);
    return recovery.code;
  }

  /** Recovery: authenticate with the recovery code, unwrap the master key,
   * register a fresh passkey, wrap the MK to it, and rotate the code. */
  async function recover(username: string, code: string): Promise<string> {
    const secret = parseRecoveryCode(code);
    const authKey = await deriveRecoveryAuthKey(secret);
    const result = await api.recoveryLogin(username, b64(authKey));
    user.value = result.user;
    const masterKey = await unwrapKey(secret, result.recoveryWrappedMk, INFO_RECOVERY_WRAP);

    const { regId, options } = await api.credentialAddOptions();
    const { response, prf } = await registerPasskey(options);
    const { credentialId } = await api.credentialAddVerify(regId, response, deviceName());
    const prfOut = await obtainPrf(prf);
    await api.credentialPutWrappedMk(credentialId, await wrapKey(prfOut, masterKey, INFO_MK_WRAP));

    setMk(masterKey);
    return rotateRecoveryCode();
  }

  /** Generate and upload a new recovery code (invalidates the old one). */
  async function rotateRecoveryCode(): Promise<string> {
    if (!mk.value) throw new Error('unlock first');
    const me = await api.me();
    if (!me.wrappedPrivateKey || !me.user.publicKey) throw new Error('keys not set up');
    const recovery = generateRecoveryCode();
    const [recoveryWrappedMk, authKey] = await Promise.all([
      wrapKey(recovery.secret, mk.value, INFO_RECOVERY_WRAP),
      deriveRecoveryAuthKey(recovery.secret),
    ]);
    await api.putKeys({
      publicKey: me.user.publicKey,
      wrappedPrivateKey: me.wrappedPrivateKey,
      recoveryWrappedMk,
      recoveryAuthHash: await sha256b64(authKey),
    });
    hasKeys.value = true;
    return recovery.code;
  }

  /** Add an extra passkey from settings and wrap the MK to it. */
  async function addPasskey(name: string): Promise<void> {
    if (!mk.value) throw new Error('unlock first');
    const { regId, options } = await api.credentialAddOptions();
    const { response, prf } = await registerPasskey(options);
    const { credentialId } = await api.credentialAddVerify(regId, response, name || deviceName());
    const prfOut = await obtainPrf(prf);
    await api.credentialPutWrappedMk(credentialId, await wrapKey(prfOut, mk.value, INFO_MK_WRAP));
  }

  async function unwrapWithPrf(prf: Uint8Array, wrappedMk: WrappedKey): Promise<void> {
    setMk(await unwrapKey(prf, wrappedMk, INFO_MK_WRAP));
  }

  async function logout(): Promise<void> {
    try {
      await api.logout();
    } finally {
      setMk(null);
      user.value = null;
      hasKeys.value = false;
      await clearCache();
    }
  }

  return {
    ready, needsSetup, appName, user, hasKeys, mk,
    loggedIn, unlocked,
    init, lock, setMk, getKeyPair,
    loginWithPasskey, register, setupKeys, recover, rotateRecoveryCode, addPasskey, unwrapWithPrf, logout,
  };
});

function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return 'iOS device';
  if (/Android/.test(ua)) return 'Android device';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Passkey';
}
