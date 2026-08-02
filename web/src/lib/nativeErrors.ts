// Catalogued failures the Rust core raises over IPC.
//
// The core has no access to the error catalogue (it is a webview asset), so it
// prefixes the stable code onto its error string — `CODE: detail` — and this
// module is the single place that turns one back into a user-facing message.
// The mapping is an explicit switch rather than a lookup so every code has a
// literal toast raise site with the code spelled out, which is what
// `web/test/lib/errors.test.ts` scans for.
//
// The Rust side of the contract: `relay_client::ERR_IDENTITY_*`,
// `delegation::ERR_DELEGATION_*` and `require_contact_key_ok`.

import { errorMessage } from './errors';
import { toastError } from './toast';

/** Codes the core can prefix onto an IPC error. */
export type CoreErrorCode =
  | 'KT_CONTACT_KEY_MISMATCH'
  | 'RELAY_DELEGATION_INVALID'
  | 'RELAY_DELEGATION_ROLLBACK'
  | 'RELAY_IDENTITY_CHANGED'
  | 'RELAY_IDENTITY_INVALID';

// Order matters: `coreErrorCode` matches by substring, and
// `RELAY_DELEGATION_ROLLBACK` must win over any prefix-sharing code so the
// attack case is never reported as the milder "can't prove its key" one.
const CORE_CODES: CoreErrorCode[] = [
  'KT_CONTACT_KEY_MISMATCH',
  'RELAY_DELEGATION_ROLLBACK',
  'RELAY_DELEGATION_INVALID',
  'RELAY_IDENTITY_CHANGED',
  'RELAY_IDENTITY_INVALID',
];

/** The catalogued code inside a core error, or null if it carries none. */
export function coreErrorCode(e: unknown): CoreErrorCode | null {
  const s = String(e);
  return CORE_CODES.find((c) => s.includes(c)) ?? null;
}

/**
 * Toast the catalogued message for a core error. Returns the code it matched,
 * or null when the error is not one of ours (caller handles it as before).
 *
 * Used on paths that would otherwise swallow the failure — a silent relay
 * identity mismatch is exactly the outcome the check exists to prevent.
 */
export function toastCoreError(e: unknown): CoreErrorCode | null {
  const code = coreErrorCode(e);
  switch (code) {
    case 'KT_CONTACT_KEY_MISMATCH':
      toastError('KT_CONTACT_KEY_MISMATCH');
      return code;
    case 'RELAY_DELEGATION_INVALID':
      toastError('RELAY_DELEGATION_INVALID');
      return code;
    case 'RELAY_DELEGATION_ROLLBACK':
      toastError('RELAY_DELEGATION_ROLLBACK');
      return code;
    case 'RELAY_IDENTITY_CHANGED':
      toastError('RELAY_IDENTITY_CHANGED');
      return code;
    case 'RELAY_IDENTITY_INVALID':
      toastError('RELAY_IDENTITY_INVALID');
      return code;
    default:
      return null;
  }
}

/**
 * Re-raise a core error as a catalogued, readable one (toasting it on the way,
 * since some callers only surface the thrown message). Anything the catalogue
 * does not know passes through untouched.
 */
export function rethrowCoreError(e: unknown): never {
  const code = toastCoreError(e);
  if (code) throw new Error(errorMessage(code));
  throw e;
}
