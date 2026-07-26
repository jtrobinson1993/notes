import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dismissToast, resetToasts, toastError, toastInfo, toasts } from '../../src/lib/toast';

beforeEach(() => {
  vi.useFakeTimers();
  resetToasts();
});
afterEach(() => {
  resetToasts();
  vi.useRealTimers();
});

describe('toasts', () => {
  it('renders a catalogued error as a sentence plus its code and first fix', () => {
    toastError('VOICE_E2EE_UNSUPPORTED');

    expect(toasts.value).toHaveLength(1);
    const t = toasts.value[0]!;
    expect(t.kind).toBe('error');
    expect(t.code).toBe('VOICE_E2EE_UNSUPPORTED');
    // The code is carried for lookup but is not what the user reads.
    expect(t.message).not.toBe(t.code);
    expect(t.hint).toBeTruthy();
  });

  it('still surfaces an uncatalogued code instead of swallowing the failure', () => {
    toastError('SOME_UNDOCUMENTED_CODE');
    expect(toasts.value).toHaveLength(1);
    expect(toasts.value[0]!.message).toBe('SOME_UNDOCUMENTED_CODE');
    expect(toasts.value[0]!.hint).toBeUndefined();
  });

  it('auto-dismisses, giving errors longer to be read than info', () => {
    toastInfo('saved');
    toastError('VOICE_E2EE_UNSUPPORTED');
    expect(toasts.value).toHaveLength(2);

    vi.advanceTimersByTime(4000);
    expect(toasts.value.map((t) => t.kind)).toEqual(['error']);

    vi.advanceTimersByTime(5000);
    expect(toasts.value).toHaveLength(0);
  });

  it('dismisses on demand and cancels the pending timer', () => {
    const id = toastInfo('saved');
    dismissToast(id);
    expect(toasts.value).toHaveLength(0);

    // A second dismissal (or the timer firing later) must not throw or
    // resurrect anything.
    dismissToast(id);
    vi.advanceTimersByTime(10_000);
    expect(toasts.value).toHaveLength(0);
  });

  it('stacks concurrent toasts with distinct ids, oldest first', () => {
    toastInfo('one');
    toastInfo('two');
    expect(toasts.value.map((t) => t.message)).toEqual(['one', 'two']);
    expect(new Set(toasts.value.map((t) => t.id)).size).toBe(2);
  });
});
