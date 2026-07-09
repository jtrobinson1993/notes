// Native-shell chat/local-log glue (D11 interim wiring).
//
// While the legacy WebSocket remains the transport (until phase 3), the
// native shell (a) serves history back-scroll from the local SQLite log —
// instant and offline — and (b) tees every live message/edit into the log so
// it stays current after migration. Ids reuse the migration composition
// `legacy:{convId}:{seq}`, so tees and migrated rows dedupe naturally.
// Reactions/read-state move to the per-conversation Yjs overlay in phase 4.

import type { ChatMessageView } from '../stores/chat';
import {
  messageEdit,
  messagesIngest,
  messagesPage,
  type ImportMessage,
  type MessageRow,
} from './native';

export function legacyMessageId(convId: string, seq: number): string {
  return `legacy:${convId}:${seq}`;
}

/** Serialize a decrypted view into a local-log row (same extras bag as the
 *  migrator: attachments/gif/system/linkPreview ride one JSON column). */
export function viewToRow(view: ChatMessageView): ImportMessage {
  const extras =
    view.attachments?.length || view.gif || view.system || view.linkPreview
      ? JSON.stringify({
          attachments: view.attachments ?? [],
          gif: view.gif ?? null,
          system: view.system ?? null,
          linkPreview: view.linkPreview ?? null,
        })
      : null;
  return {
    id: legacyMessageId(view.conversationId, view.seq),
    conversation_id: view.conversationId,
    channel_id: view.channelId === view.conversationId ? null : view.channelId,
    sender_contact_id: view.senderId,
    relay_ts: view.createdAt,
    content: view.text,
    kind: view.system ? 'system' : 'text',
    reply_ref_json: view.replyTo ? JSON.stringify(view.replyTo) : null,
    attachments_json: extras,
    edited_at: view.editedAt ?? null,
  };
}

export function rowToView(row: MessageRow): ChatMessageView {
  const seq = Number(row.id.split(':').pop());
  const extras = row.attachments_json
    ? (JSON.parse(row.attachments_json) as {
        attachments?: ChatMessageView['attachments'];
        gif?: ChatMessageView['gif'];
        system?: ChatMessageView['system'];
        linkPreview?: ChatMessageView['linkPreview'];
      })
    : {};
  return {
    conversationId: row.conversation_id,
    channelId: row.channel_id ?? row.conversation_id,
    seq,
    senderId: row.sender_contact_id ?? '',
    epoch: 0, // local rows are plaintext; epoch only matters for wire crypto
    ciphertext: '',
    iv: '',
    createdAt: row.relay_ts,
    editedAt: row.edited_at ?? undefined,
    text: row.deleted ? null : row.content,
    gif: extras.gif ?? null,
    attachments: extras.attachments ?? [],
    replyTo: row.reply_ref_json ? JSON.parse(row.reply_ref_json) : undefined,
    linkPreview: extras.linkPreview ?? undefined,
    system: extras.system ?? undefined,
    // v8 relay-native identity/order (D11): the local-log row id is globally
    // unique and `relay_ts` is the ordering stamp — so v8 rows (whose id has no
    // legacy `seq`) render in the right place and dedup by id.
    key: row.id,
    sortKey: row.relay_ts,
  };
}

/** Fire-and-forget tee of a live (or just-sent) message into the local log. */
export function teeMessage(view: ChatMessageView): void {
  void messagesIngest([viewToRow(view)]).catch(() => {});
}

export function teeEdit(view: ChatMessageView): void {
  void messageEdit(
    legacyMessageId(view.conversationId, view.seq),
    view.text,
    view.editedAt ?? Date.now(),
  ).catch(() => {});
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

export function resetNativeChat(): void {
  cursors.clear();
  exhausted.clear();
}
