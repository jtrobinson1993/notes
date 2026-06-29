import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

// Logged in but locked (no master key in memory): the lock screen must offer a
// password fallback for password-protected accounts, not only "Unlock with
// passkey". Regression for a password-only user being unable to unlock.
const session = vi.hoisted(() => ({
  loggedIn: true,
  unlocked: false,
  user: { id: 'me', handle: 'Wolf#0001' },
  loginWithPasskey: vi.fn().mockResolvedValue('ok'),
  loginWithPassword: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/stores/session', () => ({ useSessionStore: () => session }));
vi.mock('../../src/lib/mobileNav', () => ({ isMobile: false }));

import AppLayout from '../../src/components/AppLayout.vue';

const stubs = {
  AppSidebar: { template: '<div />' },
  MobileCallBar: { template: '<div />' },
  IncomingCallModal: { template: '<div />' },
};

beforeEach(() => vi.clearAllMocks());

describe('AppLayout lock screen', () => {
  it('unlocks with the password using the logged-in handle', async () => {
    const wrapper = mount(AppLayout, { global: { stubs } });

    // Switch from the default passkey prompt to the password fallback.
    await wrapper.get('button[type=button]').trigger('click');

    await wrapper.get('#unlock-password').setValue('a sufficiently long passphrase');
    await wrapper.get('form').trigger('submit');

    expect(session.loginWithPassword).toHaveBeenCalledWith('Wolf#0001', 'a sufficiently long passphrase');
    expect(session.loginWithPasskey).not.toHaveBeenCalled();
  });

  it('offers passkey unlock by default', async () => {
    const wrapper = mount(AppLayout, { global: { stubs } });
    expect(wrapper.text()).toContain('Unlock with passkey');
    expect(wrapper.find('#unlock-password').exists()).toBe(false);
  });
});
