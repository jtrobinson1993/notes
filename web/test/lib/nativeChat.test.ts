import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  messagesPage: vi.fn(),
  messagesIngest: vi.fn(),
  messageEdit: vi.fn(),
}));
vi.mock('../../src/lib/native', () => native);

import {
  loadHistoryLocal,
  resetNativeChat,
  rowToView,
  viewToRow,
} from '../../src/lib/nativeChat';
import type { ChatMessageView } from '../../src/stores/chat';
import type { MessageRow } from '../../src/lib/native';

const view = (over: Partial<ChatMessageView> = {}): ChatMessageView => ({
  conversationId: 'c1',
  channelId: 'c1',
  seq: 7,
  senderId: 'u1',
  epoch: 2,
  ciphertext: 'x',
  iv: 'x',
  createdAt: 5000,
  editedAt: null,
  text: 'hello',
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  resetNativeChat();
});

describe('viewToRow / rowToView', () => {
  it('round-trips a message with extras through the log row shape', () => {
    const v = view({
      gif: { id: 'g', url: 'https://static.klipy.com/x.gif' } as ChatMessageView['gif'],
      system: { kind: 'member-added' } as ChatMessageView['system'],
      replyTo: { seq: 3, senderId: 'u2', preview: 'p' } as ChatMessageView['replyTo'],
    });
    const row = viewToRow(v);
    expect(row.id).toBe('legacy:c1:7');
    expect(row.kind).toBe('system');

    const back = rowToView({ ...row, deleted: false } as unknown as MessageRow);
    expect(back.seq).toBe(7);
    expect(back.channelId).toBe('c1'); // null channel → general
    expect(back.text).toBe('hello');
    expect(back.gif).toMatchObject({ id: 'g' });
    expect(back.system).toMatchObject({ kind: 'member-added' });
    expect(back.replyTo).toMatchObject({ seq: 3 });
  });

  it('renders deleted rows as text: null (tombstone placeholder)', () => {
    const row = { ...viewToRow(view()), deleted: true } as unknown as MessageRow;
    expect(rowToView(row).text).toBeNull();
  });
});

describe('loadHistoryLocal', () => {
  const rows = (ids: number[]): MessageRow[] =>
    ids.map((i) => ({
      id: `legacy:c1:${i}`,
      conversation_id: 'c1',
      channel_id: null,
      sender_contact_id: 'u1',
      relay_ts: i * 100,
      content: `m${i}`,
      kind: 'text',
      reply_ref_json: null,
      attachments_json: null,
      deleted: false,
      edited_at: null,
    }));

  it('pages with a cursor and stops at exhaustion', async () => {
    native.messagesPage.mockResolvedValueOnce(rows([5, 4])).mockResolvedValueOnce(rows([3]));

    const page1 = await loadHistoryLocal('c1', 'c1', 2, true);
    expect(page1.map((v) => v.seq)).toEqual([5, 4]);
    // Second call passes the oldest row's (ts,id) as the cursor.
    const page2 = await loadHistoryLocal('c1', 'c1', 2, false);
    expect(native.messagesPage).toHaveBeenLastCalledWith(
      'c1',
      null,
      { ts: 400, id: 'legacy:c1:4' },
      2,
    );
    expect(page2.map((v) => v.seq)).toEqual([3]);
    // Short page ⇒ exhausted: no further IPC.
    const page3 = await loadHistoryLocal('c1', 'c1', 2, false);
    expect(page3).toEqual([]);
    expect(native.messagesPage).toHaveBeenCalledTimes(2);
  });

  it('reset restarts from the newest page', async () => {
    native.messagesPage.mockResolvedValue(rows([5]));
    await loadHistoryLocal('c1', 'c1', 2, true);
    await loadHistoryLocal('c1', 'c1', 2, true);
    expect(native.messagesPage).toHaveBeenLastCalledWith('c1', null, undefined, 2);
  });
});
