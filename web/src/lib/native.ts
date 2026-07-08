// Bridge to the Tauri Rust core (spec/local-store.md — the webview is UI only;
// keys and storage live in Rust and never cross this boundary).
//
// Every call here is a domain-level IPC command. In the browser (no Tauri)
// `isNative` is false and none of these functions may be called — callers
// branch on `isNative` and keep using the web paths (IndexedDB/session flows)
// until those are retired at the v8 cutover.

import { invoke, isTauri } from '@tauri-apps/api/core';

/** True when running inside the Tauri shell (any platform). */
export const isNative: boolean = isTauri();

export type VaultStatus = 'uninitialized' | 'locked' | 'unlocked';

export function vaultStatus(): Promise<VaultStatus> {
  return invoke<VaultStatus>('vault_status');
}

/**
 * First-run setup: generates the D13 key set (MK, SQLCipher key, vault key)
 * and resolves with the recovery code — display it once, never persist it.
 */
export function vaultCreate(password: string): Promise<string> {
  return invoke<string>('vault_create', { password });
}

/** Primary unlock (D3): OS keychain, no user secret (biometric-gated later). */
export function vaultUnlockKeychain(): Promise<void> {
  return invoke('vault_unlock_keychain');
}

/** Portable fallback unlock: password unwraps MK. */
export function vaultUnlock(password: string): Promise<void> {
  return invoke('vault_unlock', { password });
}

/** Break-glass unlock: recovery code (case/separator-insensitive). */
export function vaultUnlockRecovery(code: string): Promise<void> {
  return invoke('vault_unlock_recovery', { code });
}

export function vaultLock(): Promise<void> {
  return invoke('vault_lock');
}
