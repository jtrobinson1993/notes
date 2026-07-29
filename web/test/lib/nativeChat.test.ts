import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  messagesPage: vi.fn(),
}));
vi.mock('../../src/lib/native', () => native);

import { loadHistoryLocal, resetNativeChat, rowToView } from '../../src/lib/nativeChat';
import type { MessageRow } from '../../src/lib/native';

const row = (over: Partial<MessageRow> = {}): MessageRow => ({
  id: 'r1',
  conversation_id: 'c1',
  channel_id: null,
  sender_contact_id: 'u1',
  relay_ts: 5000,
  content: 'hello',
  kind: 'text',
  reply_ref_json: null,
  attachments_json: null,
  deleted: false,
  edited_at: null,
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  resetNativeChat();
});

describe('rowToView', () => {
  it('shapes a log row into the view the chat UI renders', () => {
    const v = rowToView(row());
    // v8 identity/order: the log row id is the key, relay_ts is the sort key —
    // there is no seq/epoch/ciphertext in the webview at all.
    expect(v.key).toBe('r1');
    expect(v.sortKey).toBe(5000);
    expect(v.conversationId).toBe('c1');
    expect(v.channelId).toBeNull(); // null = the conversation's general channel
    expect(v.senderId).toBe('u1');
    expect(v.text).toBe('hello');
    expect(v.attachments).toEqual([]);
    expect(v.replyTo).toBeUndefined();
    expect(v.system).toBeUndefined();
    expect(v.editedAt).toBeUndefined();
  });

  it('unpacks attachments, a system event and a reply ref out of their json', () => {
    const attachment = {
      blobId: 'b1',
      key: 'k',
      iv: 'i',
      mime: 'image/webp',
      name: 'pic.webp',
      size: 12,
    };
    const v = rowToView(
      row({
        attachments_json: JSON.stringify({
          attachments: [attachment],
          system: { kind: 'member-added' },
        }),
        reply_ref_json: JSON.stringify({ seq: 3, senderId: 'u2', preview: 'p' }),
        channel_id: 'ch2',
        edited_at: 9000,
      }),
    );
    expect(v.attachments).toEqual([attachment]);
    expect(v.system).toMatchObject({ kind: 'member-added' });
    expect(v.replyTo).toMatchObject({ seq: 3, senderId: 'u2' });
    expect(v.channelId).toBe('ch2');
    expect(v.editedAt).toBe(9000);
  });

  it('renders a deleted row as text: null (tombstone placeholder)', () => {
    expect(rowToView(row({ deleted: true })).text).toBeNull();
  });

  it('falls back to an empty sender id when the row has no verified sender', () => {
    expect(rowToView(row({ sender_contact_id: null })).senderId).toBe('');
  });
});

describe('loadHistoryLocal', () => {
  const rows = (ids: number[]): MessageRow[] =>
    ids.map((i) => row({ id: `m${i}`, content: `m${i}`, relay_ts: i * 100 }));

  it('pages with a cursor and stops at exhaustion', async () => {
    native.messagesPage.mockResolvedValueOnce(rows([5, 4])).mockResolvedValueOnce(rows([3]));

    const page1 = await loadHistoryLocal('c1', 'c1', 2, true);
    // The core pages BACKWARDS (newest-first) so the cursor can walk into
    // history, but a thread reads oldest-at-the-top — so a page comes back
    // reversed for display. Returning the pager's order unchanged put the
    // newest message at the top of the conversation.
    expect(page1.map((v) => v.key)).toEqual(['m4', 'm5']);
    // The general channel is stored as a null channel_id on the wire.
    expect(native.messagesPage).toHaveBeenLastCalledWith('c1', null, undefined, 2);

    // Second call passes the oldest row's (ts,id) as the cursor.
    const page2 = await loadHistoryLocal('c1', 'c1', 2, false);
    expect(native.messagesPage).toHaveBeenLastCalledWith('c1', null, { ts: 400, id: 'm4' }, 2);
    expect(page2.map((v) => v.key)).toEqual(['m3']);

    // Short page ⇒ exhausted: no further IPC.
    const page3 = await loadHistoryLocal('c1', 'c1', 2, false);
    expect(page3).toEqual([]);
    expect(native.messagesPage).toHaveBeenCalledTimes(2);
  });

  it('passes a non-general channel through as its own id', async () => {
    native.messagesPage.mockResolvedValue(rows([5]));
    await loadHistoryLocal('c1', 'ch2', 2, true);
    expect(native.messagesPage).toHaveBeenLastCalledWith('c1', 'ch2', undefined, 2);
  });

  it('reset restarts from the newest page', async () => {
    native.messagesPage.mockResolvedValue(rows([5]));
    await loadHistoryLocal('c1', 'c1', 2, true);
    await loadHistoryLocal('c1', 'c1', 2, true);
    expect(native.messagesPage).toHaveBeenLastCalledWith('c1', null, undefined, 2);
  });

  it('keeps cursors per channel so back-scroll in one does not skip the other', async () => {
    native.messagesPage.mockResolvedValue(rows([5, 4]));
    await loadHistoryLocal('c1', 'c1', 2, true);
    await loadHistoryLocal('c1', 'ch2', 2, true);
    expect(native.messagesPage).toHaveBeenLastCalledWith('c1', 'ch2', undefined, 2);
    await loadHistoryLocal('c1', 'c1', 2, false);
    expect(native.messagesPage).toHaveBeenLastCalledWith('c1', null, { ts: 400, id: 'm4' }, 2);
  });
});
