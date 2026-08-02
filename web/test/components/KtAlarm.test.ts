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

  it('shows the group re-key message on that alarm', async () => {
    const w = mount(KtAlarm);
    await flushPromises();
    kt.cb?.({ reason: 'group-rekey-refused' });
    await flushPromises();
    const banner = w.find('[data-testid="kt-alarm"]');
    expect(banner.exists()).toBe(true);
    // It must say the key was KEPT — the user's first question is whether the
    // attacker can now read the group.
    expect(banner.text()).toContain('replace the encryption key of a group');
    expect(banner.text()).toContain('kept your existing key');
  });

  it('explains a delegation the relay could not prove', async () => {
    const w = mount(KtAlarm);
    await flushPromises();
    kt.cb?.({ reason: 'relay-delegation-invalid' });
    await flushPromises();
    const banner = w.find('[data-testid="kt-alarm"]');
    expect(banner.exists()).toBe(true);
    expect(banner.text()).toContain('key it signs its key-transparency log with');
    // It must not fall through to the self-audit wording, which would tell the
    // user their own handle was bound to a foreign key — a different accusation.
    expect(banner.text()).not.toContain('identity key you never created');
  });

  it('names the rollback for what it is, not as a misconfiguration', async () => {
    const w = mount(KtAlarm);
    await flushPromises();
    kt.cb?.({ reason: 'relay-delegation-rollback' });
    await flushPromises();
    const banner = w.find('[data-testid="kt-alarm"]');
    expect(banner.exists()).toBe(true);
    expect(banner.text()).toContain('older record of its signing key');
    expect(banner.text()).toContain('retired key');
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
