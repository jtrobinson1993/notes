import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { ChatMessageView } from '../../src/stores/chat';

const api = vi.hoisted(() => ({
  conversations: vi.fn().mockResolvedValue([]),
  conversationMessages: vi.fn().mockResolvedValue([]),
  conversationRead: vi.fn().mockResolvedValue(undefined),
  messageSend: vi.fn(),
  conversationCreateDm: vi.fn(),
  reactions: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/lib/api', () => ({ api }));
vi.mock('../../src/stores/session', () => ({
  useSessionStore: () => ({ user: { id: 'me' }, getKeyPair: async () => ({ privateKey: new Uint8Array(32), publicKey: new Uint8Array(32) }) }),
}));
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { id: 'c1' } }), useRouter: () => ({ push: vi.fn() }) }));

import ConversationPage from '../../src/pages/ConversationPage.vue';
import { useChatStore } from '../../src/stores/chat';

const stubs = {
  AppLayout: { template: '<div><slot /></div>' },
  MarkdownView: { props: ['source'], template: '<div class="mdview">{{ source }}</div>' },
  ChatAvatar: { props: ['name', 'seed'], template: '<span class="chat-avatar">{{ name }}</span>' },
};

function seedConversation() {
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
      lastSeq: 2,
      lastReadSeq: 0,
      createdAt: 0,
    },
  ];
  return chat;
}

function msg(over: Partial<ChatMessageView>): ChatMessageView {
  return { conversationId: 'c1', seq: 1, senderId: 'friend', epoch: 0, ciphertext: '', iv: '', createdAt: 0, text: 'hi', ...over };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe('ConversationPage messages', () => {
  it('shows the undecryptable fallback for a message with text === null', async () => {
    const chat = seedConversation();
    chat.messages = { c1: [msg({ seq: 1, senderId: 'friend', text: null })] };
    const w = mount(ConversationPage, { global: { stubs } });
    await flush();

    expect(w.text()).toContain('message could not be decrypted');
    expect(w.find('.mdview').exists()).toBe(false);
  });

  it('shows an avatar + name + timestamp once at a group start, over all its messages', async () => {
    const chat = seedConversation();
    chat.messages = {
      c1: [
        msg({ seq: 1, senderId: 'friend', createdAt: 1000, text: 'one' }),
        msg({ seq: 2, senderId: 'friend', createdAt: 2000, text: 'two' }),
      ],
    };
    const w = mount(ConversationPage, { global: { stubs } });
    await flush();
    expect(w.findAll('.chat-avatar')).toHaveLength(1); // one avatar for the group
    expect(w.text()).toContain('Friend'); // name header
    expect(w.findAll('.mdview')).toHaveLength(2); // both messages render
    // The avatar sits in a fixed-height, vertically-centered box so it reads
    // centered on a single-line message and stays put when it wraps.
    const avatarBox = w.find('.chat-avatar').element.parentElement!;
    expect(avatarBox.className).toMatch(/\bitems-center\b/);
    expect(avatarBox.className).toMatch(/\bh-\d/);
  });

  it('shows an avatar + my own name for my messages too', async () => {
    const chat = seedConversation();
    chat.messages = { c1: [msg({ seq: 1, senderId: 'me', text: 'mine' })] };
    const w = mount(ConversationPage, { global: { stubs } });
    await flush();
    expect(w.findAll('.chat-avatar')).toHaveLength(1);
    expect(w.text()).toContain('Me'); // own name, not special-cased away
  });

  it('starts a new group (new avatar) when the sender changes', async () => {
    const chat = seedConversation();
    chat.messages = { c1: [msg({ seq: 1, senderId: 'friend', text: 'a' }), msg({ seq: 2, senderId: 'me', text: 'b' })] };
    const w = mount(ConversationPage, { global: { stubs } });
    await flush();
    expect(w.findAll('.chat-avatar')).toHaveLength(2);
  });

  it('puts a hover-only timestamp in the gutter for consecutive messages', async () => {
    const chat = seedConversation();
    chat.messages = {
      c1: [
        msg({ seq: 1, senderId: 'friend', createdAt: 1000, text: 'one' }),
        msg({ seq: 2, senderId: 'friend', createdAt: 2000, text: 'two' }),
      ],
    };
    const w = mount(ConversationPage, { global: { stubs } });
    await flush();
    const gutterTimes = w.findAll('time').filter((t) => (t.attributes('class') ?? '').includes('group-hover'));
    expect(gutterTimes).toHaveLength(1); // only the consecutive message
    expect(gutterTimes[0]!.classes()).toContain('hidden'); // revealed on hover only
    expect(gutterTimes[0]!.classes()).toContain('whitespace-nowrap'); // stays on one line (e.g. "11:01 PM")
  });

  it('renders full-width rows with a hover highlight and no per-message background', async () => {
    const chat = seedConversation();
    chat.messages = { c1: [msg({ seq: 1, senderId: 'friend', text: 'x' })] };
    const w = mount(ConversationPage, { global: { stubs } });
    await flush();
    const rowEl = w.find('.mdview').element.closest('.group') as HTMLElement | null;
    expect(rowEl).not.toBeNull();
    expect(rowEl!.className).toContain('hover:bg'); // hover highlight
    expect(rowEl!.className).not.toMatch(/(^|\s)bg-/); // no static background
    expect(rowEl!.className).not.toMatch(/max-w-/); // spans full width, not capped
  });
});

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}
