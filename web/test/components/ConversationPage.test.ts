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
}));
vi.mock('../../src/lib/api', () => ({ api }));
vi.mock('../../src/stores/session', () => ({
  useSessionStore: () => ({ user: { id: 'me' }, getKeyPair: async () => ({ privateKey: new Uint8Array(32), publicKey: new Uint8Array(32) }) }),
}));
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { id: 'c1' } }) }));

import ConversationPage from '../../src/pages/ConversationPage.vue';
import { useChatStore } from '../../src/stores/chat';

const stubs = {
  AppLayout: { template: '<div><slot /></div>' },
  MarkdownView: { props: ['source'], template: '<div class="mdview">{{ source }}</div>' },
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

describe('ConversationPage message alignment', () => {
  it('aligns my messages to the end and the other party’s to the start', async () => {
    const chat = seedConversation();
    chat.messages = { c1: [msg({ seq: 1, senderId: 'friend', text: 'yours' }), msg({ seq: 2, senderId: 'me', text: 'mine' })] };
    const w = mount(ConversationPage, { global: { stubs } });
    await flush();

    const rows = w.findAll('.flex.flex-col');
    // The two message rows carry items-start (other) and items-end (mine).
    const classes = rows.map((r) => r.attributes('class') ?? '');
    expect(classes.some((c) => c.includes('items-start'))).toBe(true);
    expect(classes.some((c) => c.includes('items-end'))).toBe(true);
  });

  it('shows the undecryptable fallback for a message with text === null', async () => {
    const chat = seedConversation();
    chat.messages = { c1: [msg({ seq: 1, senderId: 'friend', text: null })] };
    const w = mount(ConversationPage, { global: { stubs } });
    await flush();

    expect(w.text()).toContain('message could not be decrypted');
    expect(w.find('.mdview').exists()).toBe(false);
  });
});

describe('ConversationPage grouping, headers, and message styling', () => {
  it('shows my own display name above my messages', async () => {
    const chat = seedConversation();
    chat.messages = { c1: [msg({ seq: 1, senderId: 'me', text: 'mine' })] };
    const w = mount(ConversationPage, { global: { stubs } });
    await flush();
    expect(w.text()).toContain('Me'); // own-message header, not just the other party's name
  });

  it('renders a timestamp next to the sender name', async () => {
    const chat = seedConversation();
    chat.messages = { c1: [msg({ seq: 1, senderId: 'friend', createdAt: Date.UTC(2026, 0, 1, 15, 30), text: 'hi' })] };
    const w = mount(ConversationPage, { global: { stubs } });
    await flush();
    const time = w.find('time');
    expect(time.exists()).toBe(true);
    expect(time.text()).toMatch(/\d/);
  });

  it('shows the sender name once for consecutive messages from the same sender', async () => {
    const chat = seedConversation();
    chat.messages = {
      c1: [
        msg({ seq: 1, senderId: 'friend', createdAt: 1000, text: 'one' }),
        msg({ seq: 2, senderId: 'friend', createdAt: 2000, text: 'two' }),
      ],
    };
    const w = mount(ConversationPage, { global: { stubs } });
    await flush();
    expect(w.findAll('time')).toHaveLength(1); // a single group header...
    expect(w.findAll('.mdview')).toHaveLength(2); // ...over both messages
  });

  it('starts a new group (new header) when the sender changes', async () => {
    const chat = seedConversation();
    chat.messages = {
      c1: [msg({ seq: 1, senderId: 'friend', text: 'a' }), msg({ seq: 2, senderId: 'me', text: 'b' })],
    };
    const w = mount(ConversationPage, { global: { stubs } });
    await flush();
    expect(w.findAll('time')).toHaveLength(2);
  });

  it('gives each message a hover highlight but no static per-message background', async () => {
    const chat = seedConversation();
    chat.messages = { c1: [msg({ seq: 1, senderId: 'friend', text: 'x' })] };
    const w = mount(ConversationPage, { global: { stubs } });
    await flush();
    const row = w.find('.mdview').element.parentElement!;
    expect(row.className).toContain('hover:bg'); // highlighted on hover
    expect(row.className).not.toMatch(/(^|\s)bg-/); // no background of its own
  });
});

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}
