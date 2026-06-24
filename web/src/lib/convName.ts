import type { Conversation } from '@notes/shared';

/** Human-readable title for a conversation, from the current user's view:
 *  a DM/1:1 thread shows the other person; a group joins the other members'
 *  names; a thread shows "Thread". */
export function conversationTitle(conv: Conversation, meId: string | undefined): string {
  if (conv.kind === 'thread') return 'Thread';
  const others = conv.members.filter((m) => m.userId !== meId);
  if (conv.kind === 'group') {
    if (conv.name && conv.name.trim()) return conv.name;
    return others.length ? others.map((m) => m.displayName).join(', ') : 'Group';
  }
  return (others[0] ?? conv.members[0])?.displayName || 'Conversation';
}

/** Single-letter avatar fallback for a conversation. */
export function conversationInitial(conv: Conversation, meId: string | undefined): string {
  return (conversationTitle(conv, meId).trim()[0] ?? '?').toUpperCase();
}

/** The other member's userId in a 1:1 DM (for showing their avatar), or
 *  undefined for groups/threads. Falls back to the first member if "me" isn't
 *  found (shouldn't happen). */
export function dmPeerId(conv: Conversation, meId: string | undefined): string | undefined {
  if (conv.kind !== 'dm') return undefined;
  const others = conv.members.filter((m) => m.userId !== meId);
  return (others[0] ?? conv.members[0])?.userId;
}
