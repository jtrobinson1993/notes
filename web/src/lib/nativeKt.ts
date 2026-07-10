// Native-shell key-transparency seam (spec/key-transparency.md, client verify).
// The Rust core runs the self-audit (kt_self_audit) and emits a `kt:alarm` event
// on a HARD failure — the relay bound my handle to a key I never minted
// (self-audit-failed) or showed inconsistent roots (split-view). Here we run the
// audit on connect and fan alarms out to the UI (KtAlarm banner).
//
// A hard KT alarm is serious: it means the relay may be equivocating on
// identities, so the UI surfaces it prominently and the user should re-verify
// contacts via SAS or disconnect the relay.

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isNative, ktSelfAudit, type KtAuditReport } from './native';

export interface KtAlarm {
  /** "self-audit-failed" (foreign key) or "split-view" (inconsistent roots). */
  reason: string;
}

const listeners = new Set<(a: KtAlarm) => void>();
let latest: KtAlarm | null = null;
let unlisten: UnlistenFn | null = null;

/** Subscribe to KT alarms. Fires immediately with the latest if one is active. */
export function onKtAlarm(cb: (a: KtAlarm) => void): () => void {
  listeners.add(cb);
  if (latest) cb(latest);
  return () => {
    listeners.delete(cb);
  };
}

function raise(alarm: KtAlarm): void {
  latest = alarm;
  for (const cb of listeners) cb(alarm);
}

/** Start KT verification: subscribe to `kt:alarm` (once) and run one self-audit
 *  now (e.g. on relay connect). Idempotent; native shell only. */
export async function startKtAudit(): Promise<void> {
  if (!isNative) return;
  if (!unlisten) {
    unlisten = await listen<KtAuditReport>('kt:alarm', (e) => {
      if (e.payload.reason) raise({ reason: e.payload.reason });
    });
  }
  try {
    const report = await ktSelfAudit();
    if (!report.ok && report.reason) raise({ reason: report.reason });
  } catch {
    // No KT history (interim KT) / not connected — nothing to audit yet.
  }
}

/** Tear down the alarm listener + clear alarm state (e.g. on sign-out / relay
 *  switch; a new session re-audits from scratch). */
export async function stopKtAudit(): Promise<void> {
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
  latest = null;
  listeners.clear();
}
