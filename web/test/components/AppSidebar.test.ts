import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { ref } from 'vue';

// Rail chrome: collapse/expand + the fixed bottom navigation. The conversation
// list itself (and its unread badges) is covered by AppSidebar.native.test.ts.
vi.mock('../../src/lib/nativeConversations', async () => {
  const { ref: r } = await import('vue');
  return {
    nativeConversations: r([]),
    refreshNativeConversations: vi.fn(),
    startNativeConversations: vi.fn(),
  };
});
vi.mock('../../src/lib/nativeVault', () => ({ lockVault: vi.fn() }));
vi.mock('../../src/components/AccountSwitcher.vue', () => ({
  default: { name: 'AccountSwitcher', template: '<div />' },
}));

const currentRoute = ref({ path: '/', query: {} as Record<string, unknown> });
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), get currentRoute() { return currentRoute; } }),
}));

import AppSidebar from '../../src/components/AppSidebar.vue';

const stubs = { RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } };

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  vi.clearAllMocks();
});

describe('AppSidebar collapse / expand', () => {
  it('starts collapsed (w-14) and expands (w-56) on toggle, persisting the choice', async () => {
    const w = mount(AppSidebar, { global: { stubs } });
    const nav = w.find('nav');
    expect(nav.classes()).toContain('w-14');

    await w.get('button[aria-label="Expand"]').trigger('click');
    expect(w.find('nav').classes()).toContain('w-56');
    expect(localStorage.getItem('sidebar-expanded')).toBe('1');
  });

  it('honours a persisted expanded state on mount', () => {
    localStorage.setItem('sidebar-expanded', '1');
    const w = mount(AppSidebar, { global: { stubs } });
    expect(w.find('nav').classes()).toContain('w-56');
  });

  it('links to the Friends page (the only entry to the add-friend flow)', () => {
    const w = mount(AppSidebar, { global: { stubs } });
    expect(w.find('a[href="/friends"]').exists()).toBe(true);
  });
});

describe('AppSidebar sign out', () => {
  it('locks the vault (there is no server session to end)', async () => {
    const { lockVault } = await import('../../src/lib/nativeVault');
    const w = mount(AppSidebar, { global: { stubs } });
    await w.get('button[aria-label="Sign out"]').trigger('click');
    expect(lockVault).toHaveBeenCalled();
  });
});
