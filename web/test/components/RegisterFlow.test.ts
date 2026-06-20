import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const api = vi.hoisted(() => ({
  profileGet: vi.fn().mockResolvedValue({ handle: 'Otter#0001' }),
  handleOptions: vi.fn().mockResolvedValue({ options: ['Wolf#1234', 'Fox#5678', 'Owl#9012'] }),
  handleSet: vi.fn().mockResolvedValue({ handle: 'Wolf#1234' }),
}));
const profile = vi.hoisted(() => ({ save: vi.fn().mockResolvedValue(undefined) }));
const session = vi.hoisted(() => ({
  register: vi.fn().mockResolvedValue({ credentialId: 'c', prf: new Uint8Array(32) }),
  setupKeys: vi.fn().mockResolvedValue('RECOVERY-CODE-1234'),
}));
vi.mock('../../src/lib/api', () => ({ api }));
vi.mock('../../src/stores/session', () => ({ useSessionStore: () => session }));
vi.mock('../../src/stores/profile', () => ({ useProfileStore: () => profile }));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import RegisterFlow from '../../src/components/RegisterFlow.vue';

const stubs = { RecoveryCodeCard: { props: ['code'], template: '<div class="recovery">{{ code }}</div>' } };
const mountFlow = () => mount(RegisterFlow, { props: { title: 'Set up', subtitle: 'x' }, global: { stubs } });

const clickText = (w: ReturnType<typeof mountFlow>, text: string) =>
  w.findAll('button').find((b) => b.text().includes(text))!.trigger('click');

beforeEach(() => vi.clearAllMocks());

describe('RegisterFlow', () => {
  it('registers, encrypts the display name, then shows the handle picker', async () => {
    const w = mountFlow();
    await w.find('#username').setValue('bob');
    await w.find('#displayName').setValue('  Bob the Builder  ');
    await w.find('form').trigger('submit');
    await flushPromises();

    expect(session.register).toHaveBeenCalledWith('bob', undefined);
    // The display name is encrypted into the profile (not sent as plaintext).
    expect(profile.save).toHaveBeenCalledWith({ displayName: 'Bob the Builder' });
    // Now on the handle-pick step, showing the auto-assigned handle + options.
    expect(w.text()).toContain('Pick your handle');
    expect(w.text()).toContain('Otter#0001');

    // Choosing an option sets it and advances to the recovery step.
    await clickText(w, 'Wolf#1234');
    await flushPromises();
    expect(api.handleSet).toHaveBeenCalledWith('Wolf#1234');
    expect(w.find('.recovery').text()).toContain('RECOVERY-CODE-1234');
  });

  it('reaches the handle step even if encrypting the name fails (account already exists)', async () => {
    profile.save.mockRejectedValueOnce(new Error('boom'));
    const w = mountFlow();
    await w.find('#username').setValue('bob');
    await w.find('#displayName').setValue('Bob');
    await w.find('form').trigger('submit');
    await flushPromises();

    expect(w.text()).toContain('Pick your handle');
    // Keeping the current handle reaches the recovery step.
    await clickText(w, 'Keep');
    expect(w.find('.recovery').exists()).toBe(true);
  });
});
