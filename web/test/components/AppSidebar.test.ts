import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

const api = vi.hoisted(() => ({
  conversations: vi.fn().mockResolvedValue([]),
  friends: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/lib/api', () => ({ api }));
vi.mock('../../src/stores/session', () => ({ useSessionStore: () => ({ user: { id: 'me' } }) }));
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), currentRoute: { value: { path: '/chat/c1' } } }),
}));
// The new-chat modal (and its reka-ui Dialog internals) isn't relevant here.
vi.mock('../../src/components/NewChatModal.vue', () => ({
  default: { name: 'NewChatModal', template: '<div />' },
}));

import AppSidebar from '../../src/components/AppSidebar.vue';
import { useChatStore } from '../../src/stores/chat';

const stubs = { RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } };

function seedUnread() {
  const chat = useChatStore();
  chat.conversations = [
    {
      id: 'c1',
      kind: 'dm',
      members: [
        { userId: 'me', displayName: 'Me', publicKey: null },
        { userId: 'friend', displayName: 'Friend', publicKey: null },
      ],
      sealedKey: { epk: '', iv: '', ct: '' },
      epoch: 0,
      lastSeq: 5,
      lastReadSeq: 2,
      createdAt: 0,
    },
  ];
}

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

describe('AppSidebar unread badge', () => {
  it('renders the unread count (lastSeq - lastReadSeq)', () => {
    seedUnread();
    const w = mount(AppSidebar, { global: { stubs } });
    // unread = 5 - 2 = 3, shown in the badge.
    expect(w.text()).toContain('3');
  });

  it('shows no badge once fully read', () => {
    const chat = useChatStore();
    chat.conversations = [
      {
        id: 'c1', kind: 'dm',
        members: [{ userId: 'me', displayName: 'Me', publicKey: null }, { userId: 'friend', displayName: 'Friend', publicKey: null }],
        sealedKey: { epk: '', iv: '', ct: '' }, epoch: 0, lastSeq: 5, lastReadSeq: 5, createdAt: 0,
      },
    ];
    const w = mount(AppSidebar, { global: { stubs } });
    const badges = w.findAll('.bg-blue-600').filter((n) => /^\d+$/.test(n.text().trim()));
    expect(badges).toHaveLength(0);
  });
});
