// Native v8 DM surface (D4b/D6/D11) — the clean API the friends/DM UI builds on,
// composing the Rust-core IPC (friends, DM conversation identity, send) with the
// local-log history reader. Kept separate from the legacy server-sourced chat
// store: a v8 DM's messages live in the local encrypted log and its identity is
// derived from the two friends' keys, so this path needs neither the server nor
// the seq model.

import { dmConversationId, friendsList, relaySendMessage } from './native';
import { loadHistoryLocal } from './nativeChat';
import type { ChatMessageView } from '../stores/chat';

export interface DmSummary {
  /** The friend's local contact id (their per-relay identity key, base64). */
  contactId: string;
  handle: string;
  displayName: string | null;
  /** Deterministic DM conversation id (both sides compute the same one). */
  conversationId: string;
}

/** One v8 DM per friend, each resolved to its deterministic conversation id. */
export async function listDms(): Promise<DmSummary[]> {
  const friends = await friendsList();
  return Promise.all(
    friends.map(async (f) => ({
      contactId: f.contact_id,
      handle: f.handle,
      displayName: f.display_name,
      conversationId: await dmConversationId(f.contact_id),
    })),
  );
}

/** Open a friend's DM: resolve its conversation id (ensuring the row exists) and
 *  load the newest page from the local log. */
export async function openDm(
  contactId: string,
  limit: number,
): Promise<{ conversationId: string; messages: ChatMessageView[] }> {
  const conversationId = await dmConversationId(contactId);
  // DMs have no sub-channels: channel id == conversation id.
  const messages = await loadHistoryLocal(conversationId, conversationId, limit, true);
  return { conversationId, messages };
}

/** Send a text to a friend. The core seals + delivers it and tees the same id
 *  into the local log; resolves with the message id (re-read via openDm to show
 *  it, or reloadActiveFromLog if the conversation is the active one). */
export function sendDm(contactId: string, text: string): Promise<string> {
  return relaySendMessage(contactId, text);
}
