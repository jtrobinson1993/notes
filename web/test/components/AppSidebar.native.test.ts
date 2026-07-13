import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { ref } from 'vue';

// The app rail in the native shell: every friend + group, most recent first.
const convs = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('../../src/lib/nativeConversations', async () => {
  const { ref: r } = await import('vue');
  const nativeConversations = r(convs.list);
  return {
    get nativeConversations() {
      nativeConversations.value = convs.list;
      return nativeConversations;
    },
    refreshNativeConversations: vi.fn(),
    startNativeConversations: vi.fn(),
  };
});
vi.mock('../../src/lib/native', () => ({ isNative: true }));
vi.mock('../../src/lib/nativeVault', () => ({ lockVault: vi.fn() }));
vi.mock('../../src/lib/api', () => ({
  api: { conversations: vi.fn().mockResolvedValue([]), friends: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../../src/stores/session', () => ({
  useSessionStore: () => ({ user: { id: 'me' }, unlocked: true }),
}));
vi.mock('../../src/components/AccountSwitcher.vue', () => ({
  default: { name: 'AccountSwitcher', template: '<div />' },
}));

import AppSidebar from '../../src/components/AppSidebar.vue';

const push = vi.fn();
const currentRoute = ref({ path: '/dm', query: { open: 'dm:idA' } as Record<string, unknown> });
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, get currentRoute() { return currentRoute; } }),
}));

const stubs = { RouterLink: { props: ['to'], template: '<a :href="JSON.stringify(to)"><slot /></a>' } };

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  vi.clearAllMocks();
  convs.list = [
    { key: 'grp:g1', kind: 'group', id: 'g1', conversationId: 'g1', title: 'Book club', initial: 'B', unread: 3, lastTs: 90 },
    { key: 'dm:idA', kind: 'dm', id: 'idA', conversationId: 'dm:A', title: 'Alice', initial: 'A', unread: 0, lastTs: 40 },
    { key: 'dm:idZ', kind: 'dm', id: 'idZ', conversationId: 'dm:Z', title: 'Zoe', initial: 'Z', unread: 0, lastTs: 0 },
  ];
});

describe('AppSidebar (native shell)', () => {
  it('lists every friend + group in activity order, as icons, linking to their chat', () => {
    const w = mount(AppSidebar, { global: { stubs } });
    const links = w.findAll('a');
    // The rail's chat links, in order: the list's order (already most-recent-first).
    const chats = links.filter((l) => l.attributes('href')?.includes('/dm'));
    expect(chats.map((l) => l.attributes('aria-label'))).toEqual(['Book club', 'Alice', 'Zoe']);
    // Collapsed: the icon (initial), no name — and the unread badge.
    expect(chats[0].text()).toContain('B');
    expect(chats[0].text()).toContain('3');
    expect(chats[1].text()).not.toContain('Alice');
    // Clicking opens that conversation in the chat surface.
    expect(JSON.parse(chats[1].attributes('href')!)).toEqual({ path: '/dm', query: { open: 'dm:idA' } });
  });

  it('shows each friend’s name next to their icon when the rail is expanded', async () => {
    localStorage.setItem('sidebar-expanded', '1');
    const w = mount(AppSidebar, { global: { stubs } });
    const chats = w.findAll('a').filter((l) => l.attributes('href')?.includes('/dm'));
    expect(chats.map((l) => l.text())).toEqual(
      expect.arrayContaining([expect.stringContaining('Alice'), expect.stringContaining('Zoe')]),
    );
    expect(chats[0].text()).toContain('Book club');
  });
});
