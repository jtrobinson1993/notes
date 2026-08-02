import { beforeEach, describe, expect, it } from 'vitest';
import { coreErrorCode, rethrowCoreError, toastCoreError } from '../../src/lib/nativeErrors';
import { errorEntry, errorMessage } from '../../src/lib/errors';
import { resetToasts, toasts } from '../../src/lib/toast';

// The Rust core cannot read the error catalogue (it is a webview asset), so it
// prefixes a stable code onto its error string and this module is the single
// place that turns one back into a user-facing message. These cases treat that
// as the contract it is: a code the core raises but the webview does not map
// degrades to a silent failure on exactly the paths built to be loud.

beforeEach(resetToasts);

describe('core error codes', () => {
  it('recognises every code the core prefixes, including the delegation chain', () => {
    expect(coreErrorCode('RELAY_IDENTITY_CHANGED: expected relay A, got B')).toBe(
      'RELAY_IDENTITY_CHANGED',
    );
    expect(coreErrorCode('RELAY_IDENTITY_INVALID: the relay served no identity key')).toBe(
      'RELAY_IDENTITY_INVALID',
    );
    expect(
      coreErrorCode('RELAY_DELEGATION_INVALID: delegation v1 is not signed by the pinned relay root'),
    ).toBe('RELAY_DELEGATION_INVALID');
    expect(
      coreErrorCode('RELAY_DELEGATION_ROLLBACK: the relay served delegation v1, older than v2'),
    ).toBe('RELAY_DELEGATION_ROLLBACK');
    expect(coreErrorCode('relay unreachable: connection refused')).toBeNull();
  });

  it('never reports a rollback as the milder delegation failure', () => {
    // A rollback is an attack in progress (somebody replaying a superseded,
    // still-validly-signed record to reinstate a revoked key); "this relay
    // can't prove its key" reads like a misconfiguration. Matching is by
    // substring, so the ordering that keeps these apart is worth a test.
    const e = 'RELAY_DELEGATION_ROLLBACK: the relay served delegation v1, older than v3';
    expect(coreErrorCode(e)).toBe('RELAY_DELEGATION_ROLLBACK');
    expect(toastCoreError(e)).toBe('RELAY_DELEGATION_ROLLBACK');
    expect(toasts.value.at(-1)).toMatchObject({ code: 'RELAY_DELEGATION_ROLLBACK' });
  });

  it('toasts a catalogued message for each delegation failure', () => {
    for (const code of ['RELAY_DELEGATION_INVALID', 'RELAY_DELEGATION_ROLLBACK'] as const) {
      resetToasts();
      expect(toastCoreError(`${code}: detail the user never sees`)).toBe(code);
      const t = toasts.value.at(-1)!;
      expect(t.kind).toBe('error');
      expect(t.code).toBe(code);
      // The catalogue entry, not the bare code — the toast is what the user reads.
      expect(t.message).not.toBe(code);
      expect(errorEntry(code)).toBeDefined();
    }
  });

  it('rethrows a delegation failure as its readable message', () => {
    expect(() => rethrowCoreError('RELAY_DELEGATION_ROLLBACK: v1 < v2')).toThrow(
      errorMessage('RELAY_DELEGATION_ROLLBACK'),
    );
    // Anything the catalogue does not know passes through untouched.
    const other = new Error('relay unreachable');
    expect(() => rethrowCoreError(other)).toThrow(other);
    expect(toastCoreError(other)).toBeNull();
  });
});
