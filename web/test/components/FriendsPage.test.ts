import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

// A friends list that FAILS to load must never render the "No friends yet"
// empty-state: that reads as "your friends are gone" when they are merely
// unreachable (e.g. the native core isn't connected to a relay yet, so
// `friends_list` rejects before it ever queries the vault).
const friendsStore = vi.hoisted(() => ({
  friends: [] as unknown[],
  requests: [] as unknown[],
  invites: [] as unknown[],
  load: vi.fn(),
  createInvite: vi.fn(),
  redeem: vi.fn(),
  unfriend: vi.fn(),
  accept: vi.fn(),
  decline: vi.fn(),
  cancel: vi.fn(),
  revokeInvite: vi.fn(),
}));
vi.mock('../../src/stores/friends', () => ({ useFriendsStore: () => friendsStore }));
vi.mock('../../src/stores/chat', () => ({ useChatStore: () => ({ openDm: vi.fn() }) }));
vi.mock('../../src/lib/native', () => ({ isNative: true }));
vi.mock('../../src/components/AppLayout.vue', () => ({
  default: { name: 'AppLayout', template: '<div><slot /></div>' },
}));
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import FriendsPage from '../../src/pages/FriendsPage.vue';

const stubs = { RouterLink: { props: ['to'], template: '<a><slot /></a>' } };

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  friendsStore.friends = [];
  friendsStore.requests = [];
  friendsStore.invites = [];
});

describe('FriendsPage', () => {
  it('surfaces the reason a load failed, and does NOT claim there are no friends', async () => {
    // The native core rejects with a plain string, not an Error.
    friendsStore.load.mockRejectedValue('not connected to a relay');

    const w = mount(FriendsPage, { global: { stubs } });
    await flushPromises();

    expect(w.text()).toContain('not connected to a relay'); // the actionable reason
    expect(w.text()).not.toContain('No friends yet'); // never imply the data is gone
  });

  it('shows the empty-state only when the load genuinely succeeded with no friends', async () => {
    friendsStore.load.mockResolvedValue(undefined);

    const w = mount(FriendsPage, { global: { stubs } });
    await flushPromises();

    expect(w.text()).toContain('No friends yet');
  });

  it('lists the friends a successful load returned', async () => {
    friendsStore.load.mockImplementation(async () => {
      friendsStore.friends = [{ userId: 'u1', displayName: 'Gull#6109', handle: 'Gull#6109', online: false }];
    });

    const w = mount(FriendsPage, { global: { stubs } });
    await flushPromises();

    expect(w.text()).toContain('Gull#6109');
    expect(w.text()).not.toContain('No friends yet');
  });
});
