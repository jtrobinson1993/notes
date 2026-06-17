import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const api = vi.hoisted(() => ({ profileSet: vi.fn().mockResolvedValue({ displayName: 'Bob' }) }));
const session = vi.hoisted(() => ({
  register: vi.fn().mockResolvedValue({ credentialId: 'c', prf: new Uint8Array(32) }),
  setupKeys: vi.fn().mockResolvedValue('RECOVERY-CODE-1234'),
}));
vi.mock('../../src/lib/api', () => ({ api }));
vi.mock('../../src/stores/session', () => ({ useSessionStore: () => session }));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import RegisterFlow from '../../src/components/RegisterFlow.vue';

const stubs = { RecoveryCodeCard: { props: ['code'], template: '<div class="recovery">{{ code }}</div>' } };
const mountFlow = () => mount(RegisterFlow, { props: { title: 'Set up', subtitle: 'x' }, global: { stubs } });

beforeEach(() => vi.clearAllMocks());

describe('RegisterFlow', () => {
  it('registers, then persists the (trimmed) display name and advances to recovery', async () => {
    const w = mountFlow();
    await w.find('#username').setValue('bob');
    await w.find('#displayName').setValue('  Bob the Builder  ');
    await w.find('form').trigger('submit');
    await flushPromises();

    expect(session.register).toHaveBeenCalledWith('bob', undefined);
    expect(api.profileSet).toHaveBeenCalledWith({ displayName: 'Bob the Builder' });
    // Moved on to the recovery-code step.
    expect(w.find('.recovery').text()).toContain('RECOVERY-CODE-1234');
  });

  it('still reaches recovery if persisting the name fails (account already exists)', async () => {
    api.profileSet.mockRejectedValueOnce(new Error('boom'));
    const w = mountFlow();
    await w.find('#username').setValue('bob');
    await w.find('#displayName').setValue('Bob');
    await w.find('form').trigger('submit');
    await flushPromises();

    expect(w.find('.recovery').exists()).toBe(true);
  });
});
