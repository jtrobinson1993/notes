import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const native = vi.hoisted(() => ({
  isNative: true,
  vaultStatus: vi.fn(),
  vaultCreate: vi.fn(),
  vaultUnlock: vi.fn(),
  vaultUnlockKeychain: vi.fn(),
  vaultUnlockRecovery: vi.fn(),
}));
vi.mock('../../src/lib/native', () => native);

import NativeGate from '../../src/components/NativeGate.vue';

const mountGate = () =>
  mount(NativeGate, { slots: { default: '<div data-testid="app">app</div>' } });

beforeEach(() => {
  vi.resetAllMocks();
  native.isNative = true;
});

describe('NativeGate', () => {
  it('slots straight through in the browser', async () => {
    native.isNative = false;
    const w = mountGate();
    expect(w.find('[data-testid="app"]').exists()).toBe(true);
    expect(native.vaultStatus).not.toHaveBeenCalled();
  });

  it('unlocks silently via the keychain when locked', async () => {
    native.vaultStatus.mockResolvedValue('locked');
    native.vaultUnlockKeychain.mockResolvedValue(undefined);
    const w = mountGate();
    await flushPromises();
    expect(w.find('[data-testid="app"]').exists()).toBe(true);
  });

  it('falls back to the unlock form when the keychain fails', async () => {
    native.vaultStatus.mockResolvedValue('locked');
    native.vaultUnlockKeychain.mockRejectedValue(new Error('nope'));
    const w = mountGate();
    await flushPromises();
    expect(w.find('[data-testid="app"]').exists()).toBe(false);
    expect(w.text()).toContain('Unlock');

    native.vaultUnlock.mockResolvedValue(undefined);
    await w.find('input[type="password"]').setValue('some password here!!');
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(w.find('[data-testid="app"]').exists()).toBe(true);
  });

  it('walks setup → recovery display → ready on first run', async () => {
    native.vaultStatus.mockResolvedValue('uninitialized');
    native.vaultCreate.mockResolvedValue('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH');
    const w = mountGate();
    await flushPromises();
    expect(w.text()).toContain('Set up this device');

    const [pw, confirm] = w.findAll('input[type="password"]');
    await pw.setValue('a sixteen char password');
    await confirm.setValue('a sixteen char password');
    await w.find('form').trigger('submit');
    await flushPromises();

    expect(w.find('[data-testid="recovery-code"]').text()).toContain('AAAA-BBBB');
    await w.find('button').trigger('click');
    expect(w.find('[data-testid="app"]').exists()).toBe(true);
  });

  it('rejects a short password client-side', async () => {
    native.vaultStatus.mockResolvedValue('uninitialized');
    const w = mountGate();
    await flushPromises();
    const [pw, confirm] = w.findAll('input[type="password"]');
    await pw.setValue('short');
    await confirm.setValue('short');
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(native.vaultCreate).not.toHaveBeenCalled();
    expect(w.text()).toContain('at least 16 characters');
  });
});
