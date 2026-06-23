import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { UserInfo, WrappedKey } from '@notes/shared';
import { api } from '../lib/api';
import { b64, ub64 } from '../lib/b64';
import {
  generateKeyPair,
  generateMasterKey,
  INFO_MK_WRAP,
  INFO_PASSWORD_WRAP,
  INFO_PRIVATE_KEY,
  INFO_RECOVERY_WRAP,
  sha256b64,
  unwrapKey,
  wrapKey,
} from '../lib/crypto';
import { clearCache } from '../lib/idb';
import { deriveRecoveryAuthKey, generateRecoveryCode, parseRecoveryCode } from '../lib/recovery';
import { derivePasswordAuthKey, derivePasswordKey, generatePasswordSalt } from '../lib/password';
import { authenticatePasskey, registerPasskey } from '../lib/webauthn';

const MK_STORAGE_KEY = 'notes:mk';

export const useSessionStore = defineStore('session', () => {
  const ready = ref(false);
  const needsSetup = ref(false);
  const appName = ref('Notes');
  const user = ref<UserInfo | null>(null);
  const hasKeys = ref(false);
  /** Whether the user has set the optional password fallback. */
  const hasPassword = ref(false);
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
      hasPassword.value = me.hasPassword;
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
    hasPassword.value = me.hasPassword;
    return 'ok';
  }

  /** Password-fallback login: derive the Argon2id key from the handle's salt +
   *  the password, prove it to the server, and unwrap MK from the returned blob.
   *  For users whose passkey can't produce the PRF output (e.g. Firefox/Linux
   *  without a syncing provider). */
  async function loginWithPassword(handle: string, password: string): Promise<void> {
    const { salt } = await api.passwordOptions(handle);
    const passwordKey = await derivePasswordKey(password, ub64(salt));
    const authKey = await derivePasswordAuthKey(passwordKey);
    const result = await api.passwordLogin(handle, b64(authKey));
    user.value = result.user;
    needsSetup.value = false;
    setMk(await unwrapKey(passwordKey, result.passwordWrappedMk, INFO_PASSWORD_WRAP));
    const me = await api.me();
    hasKeys.value = me.hasKeys;
    hasPassword.value = me.hasPassword;
  }

  /** Set (or replace) the optional password fallback. Requires an unlocked
   *  session: a copy of MK is wrapped under the password-derived key. There is
   *  NO password reset — losing the password, passkey, and recovery code all at
   *  once is unrecoverable. */
  async function setPassword(password: string): Promise<void> {
    if (!mk.value) throw new Error('unlock first');
    const salt = generatePasswordSalt();
    const passwordKey = await derivePasswordKey(password, salt);
    const [passwordWrappedMk, authKey] = await Promise.all([
      wrapKey(passwordKey, mk.value, INFO_PASSWORD_WRAP),
      derivePasswordAuthKey(passwordKey),
    ]);
    await api.passwordSet({ salt: b64(salt), passwordWrappedMk, passwordAuthHash: await sha256b64(authKey) });
    hasPassword.value = true;
  }

  /** Remove the password fallback (passkey + recovery code remain). */
  async function removePassword(): Promise<void> {
    await api.passwordClear();
    hasPassword.value = false;
  }

  /** Create the account + first passkey (setup or invite signup). The account's
   *  identifier — the auto-generated "Word#1234" handle — is assigned server-side;
   *  there is no user-chosen username. */
  async function register(inviteToken?: string): Promise<{ credentialId: string; prf: Uint8Array | null }> {
    const { regId, options } = await api.registerOptions(inviteToken);
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

  /** Recovery: authenticate with the handle + recovery code, unwrap the master
   * key, register a fresh passkey, wrap the MK to it, and rotate the code. */
  async function recover(handle: string, code: string): Promise<string> {
    const secret = parseRecoveryCode(code);
    const authKey = await deriveRecoveryAuthKey(secret);
    const result = await api.recoveryLogin(handle, b64(authKey));
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
      hasPassword.value = false;
      await clearCache();
    }
  }

  return {
    ready, needsSetup, appName, user, hasKeys, hasPassword, mk,
    loggedIn, unlocked,
    init, lock, setMk, getKeyPair,
    loginWithPasskey, loginWithPassword, register, setupKeys, recover, rotateRecoveryCode,
    addPasskey, setPassword, removePassword, unwrapWithPrf, logout,
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
