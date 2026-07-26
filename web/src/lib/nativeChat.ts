// Local-log history reader (D11).
//
// Chat history is served from the local encrypted SQLite log — instant and
// offline. The Rust core writes it (the mailbox drain opens/verifies envelopes
// and ingests rows); this module only pages it back out and shapes rows into
// the view the chat UI renders.

import type { ChatMessageView } from './chatView';
import { messagesPage, type MessageAttachment, type MessageRow } from './native';

export function rowToView(row: MessageRow): ChatMessageView {
  const extras = row.attachments_json
    ? (JSON.parse(row.attachments_json) as {
        attachments?: MessageAttachment[];
        system?: ChatMessageView['system'];
      })
    : {};
  return {
    key: row.id,
    conversationId: row.conversation_id,
    channelId: row.channel_id,
    senderId: row.sender_contact_id ?? '',
    sortKey: row.relay_ts,
    text: row.deleted ? null : row.content,
    attachments: extras.attachments ?? [],
    replyTo: row.reply_ref_json ? JSON.parse(row.reply_ref_json) : undefined,
    system: extras.system ?? undefined,
    editedAt: row.edited_at ?? undefined,
  };
}

// Back-scroll cursors, keyed by channel id. `reset` (a fresh open, no
// `before`) restarts from the newest page.
const cursors = new Map<string, { ts: number; id: string }>();
const exhausted = new Set<string>();

export async function loadHistoryLocal(
  convId: string,
  channelId: string,
  limit: number,
  reset: boolean,
): Promise<ChatMessageView[]> {
  if (reset) {
    cursors.delete(channelId);
    exhausted.delete(channelId);
  }
  if (exhausted.has(channelId)) return [];
  const rows = await messagesPage(
    convId,
    channelId === convId ? null : channelId,
    cursors.get(channelId),
    limit,
  );
  const oldest = rows.at(-1);
  if (oldest) cursors.set(channelId, { ts: oldest.relay_ts, id: oldest.id });
  if (rows.length < limit) exhausted.add(channelId);
  return rows.map(rowToView);
}

/** Drop the paging cursors — on lock, or when switching account. */
export function resetNativeChat(): void {
  cursors.clear();
  exhausted.clear();
}
