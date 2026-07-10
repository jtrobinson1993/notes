import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const kt = vi.hoisted(() => ({
  cb: null as null | ((a: { reason: string }) => void),
  onKtAlarm: vi.fn(),
  startKtAudit: vi.fn().mockResolvedValue(undefined),
  stopKtAudit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/lib/nativeKt', () => ({
  onKtAlarm: (cb: (a: { reason: string }) => void) => {
    kt.cb = cb;
    return kt.onKtAlarm(cb);
  },
  startKtAudit: () => kt.startKtAudit(),
  stopKtAudit: () => kt.stopKtAudit(),
}));

const native = vi.hoisted(() => ({ isNative: true }));
vi.mock('../../src/lib/native', () => native);

import KtAlarm from '../../src/components/KtAlarm.vue';

beforeEach(() => {
  vi.clearAllMocks();
  native.isNative = true;
  kt.cb = null;
});

describe('KtAlarm', () => {
  it('is hidden until an alarm fires, and starts the audit on mount', async () => {
    const w = mount(KtAlarm);
    await flushPromises();
    expect(kt.startKtAudit).toHaveBeenCalled();
    expect(w.find('[data-testid="kt-alarm"]').exists()).toBe(false);
  });

  it('shows the split-view message on that alarm', async () => {
    const w = mount(KtAlarm);
    await flushPromises();
    kt.cb?.({ reason: 'split-view' });
    await flushPromises();
    const banner = w.find('[data-testid="kt-alarm"]');
    expect(banner.exists()).toBe(true);
    expect(banner.text()).toContain('inconsistent key-transparency logs');
  });

  it('shows the foreign-key message for a self-audit failure', async () => {
    const w = mount(KtAlarm);
    await flushPromises();
    kt.cb?.({ reason: 'self-audit-failed' });
    await flushPromises();
    expect(w.find('[data-testid="kt-alarm"]').text()).toContain('identity key you never created');
  });

  it('does nothing outside the native shell', async () => {
    native.isNative = false;
    const w = mount(KtAlarm);
    await flushPromises();
    expect(kt.startKtAudit).not.toHaveBeenCalled();
    expect(w.find('[data-testid="kt-alarm"]').exists()).toBe(false);
  });
});
