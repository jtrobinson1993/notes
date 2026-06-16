import type { Conversation } from '@notes/shared';

/** Human-readable title for a conversation, from the current user's view:
 *  a DM/1:1 thread shows the other person; a group joins the other members'
 *  names; a thread shows "Thread". */
export function conversationTitle(conv: Conversation, meId: string | undefined): string {
  if (conv.kind === 'thread') return 'Thread';
  const others = conv.members.filter((m) => m.userId !== meId);
  if (conv.kind === 'group') {
    return others.length ? others.map((m) => m.displayName).join(', ') : 'Group';
  }
  return (others[0] ?? conv.members[0])?.displayName || 'Conversation';
}

/** Single-letter avatar fallback for a conversation. */
export function conversationInitial(conv: Conversation, meId: string | undefined): string {
  return (conversationTitle(conv, meId).trim()[0] ?? '?').toUpperCase();
}
