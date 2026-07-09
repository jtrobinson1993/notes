// Native v8 group surface (D6/D14) — the API the group UI builds on. A group is
// a conversation whose id is the group id and whose messages live in the local
// log (fanned out by the relay under the shared group key). Unread/read reuse
// the conversation-agnostic dm_unread / dm_mark_read.

import {
  dmMarkRead,
  dmUnread,
  groupAddMember,
  groupCreate,
  groupList,
  relaySendGroupMessage,
} from './native';
import { loadHistoryLocal } from './nativeChat';
import type { ChatMessageView } from '../stores/chat';

export interface GroupItem {
  groupId: string;
  name: string | null;
  /** Conversation id == group id (its messages key by it). */
  conversationId: string;
  unread: number;
}

/** Groups I'm a member of, each with its unread count. */
export async function listGroups(): Promise<GroupItem[]> {
  const groups = await groupList();
  return Promise.all(
    groups.map(async (g) => ({
      groupId: g.group_id,
      name: g.name,
      conversationId: g.group_id,
      unread: await dmUnread(g.group_id),
    })),
  );
}

/** Open a group: load the newest local-log page + mark it read. */
export async function openGroup(
  groupId: string,
  limit: number,
): Promise<{ conversationId: string; messages: ChatMessageView[] }> {
  const messages = await loadHistoryLocal(groupId, groupId, limit, true);
  await dmMarkRead(groupId);
  return { conversationId: groupId, messages };
}

/** Send a text to a group (relay fans it out under the group key). */
export function sendGroup(groupId: string, text: string): Promise<string> {
  return relaySendGroupMessage(groupId, text);
}

/** Create a group I own; resolves with its id. */
export function createGroup(name: string): Promise<string> {
  return groupCreate(name);
}

/** Add a friend to a group I administer (updates the record + hands them the key). */
export function addGroupMember(groupId: string, contactId: string): Promise<void> {
  return groupAddMember(groupId, contactId);
}
