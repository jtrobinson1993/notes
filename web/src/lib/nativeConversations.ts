// Shared native conversation list for the app side rail (native shell). Mirrors
// the legacy layout: every friend (their DM) plus every group shows in the rail
// above Notes, each with a title + icon-initial derived from the member/group
// name, and clicking one opens that conversation. Ordered by most recent
// activity, so the people you talk to are at the top; friends you've never
// messaged still show (below the active chats), since a v8 DM exists for every
// friend by construction. Kept as a small reactive module (not a full store) so
// both the rail and the chat view can read it and it refreshes on every mailbox
// drain.

import { ref } from 'vue';
import { conversationActivity } from './native';
import { listDms } from './nativeDm';
import { listGroups } from './nativeGroup';
import { onMailIngested, onRelayConnected } from './nativeRelay';

export interface NativeConvItem {
  /** Route key: `dm:<contactId>` | `grp:<groupId>`. */
  key: string;
  kind: 'dm' | 'group';
  /** contactId (dm) or groupId (group). */
  id: string;
  conversationId: string;
  title: string;
  initial: string;
  unread: number;
  /** Newest message's relay stamp; 0 when the conversation has no messages. */
  lastTs: number;
}

export const nativeConversations = ref<NativeConvItem[]>([]);

function initial(s: string): string {
  return (s.trim()[0] ?? '?').toUpperCase();
}

/** Most recent activity first; never-messaged chats fall to the bottom, ordered
 *  by name so the rail doesn't reshuffle arbitrarily between refreshes. */
function byActivity(a: NativeConvItem, b: NativeConvItem): number {
  if (a.lastTs !== b.lastTs) return b.lastTs - a.lastTs;
  return a.title.localeCompare(b.title);
}

export async function refreshNativeConversations(): Promise<void> {
  const [dms, groups, activity] = await Promise.all([
    listDms(),
    listGroups(),
    conversationActivity(),
  ]);
  const byConv = new Map(activity.map((a) => [a.conversation_id, a]));
  const items: NativeConvItem[] = [
    ...dms.map((d) => {
      const title = d.displayName || d.handle;
      return {
        key: `dm:${d.contactId}`,
        kind: 'dm' as const,
        id: d.contactId,
        conversationId: d.conversationId,
        title,
        initial: initial(title),
        unread: d.unread,
        lastTs: byConv.get(d.conversationId)?.last_ts ?? 0,
      };
    }),
    ...groups.map((g) => {
      const title = g.name || 'Group';
      return {
        key: `grp:${g.groupId}`,
        kind: 'group' as const,
        id: g.groupId,
        conversationId: g.conversationId,
        title,
        initial: initial(title),
        unread: g.unread,
        lastTs: byConv.get(g.conversationId)?.last_ts ?? 0,
      };
    }),
  ];
  nativeConversations.value = items.sort(byActivity);
}

let offIngested: (() => void) | null = null;
let offConnected: (() => void) | null = null;

/**
 * Begin keeping the rail's list current: load once, then refresh on each drain
 * and once the relay session comes up.
 *
 * The relay subscription is not redundant. This runs the moment the vault gate
 * opens, which is *before* the cold-start redial completes, so the first
 * refresh reliably fails with "not connected to a relay" (DM ids are derived
 * from the relay fingerprint). Drains only notify when they ingest something,
 * so without the connect hook the rail stayed empty until mail happened to
 * arrive — even though every conversation was already in the local store.
 */
export function startNativeConversations(): void {
  if (offIngested) return;
  offIngested = onMailIngested(() => void refreshNativeConversations());
  offConnected = onRelayConnected(() => void refreshNativeConversations());
  void refreshNativeConversations();
}

/** Stop refreshing and clear the list. Called when the vault re-locks: the
 *  titles are friends' decrypted display names, so they must not survive the
 *  master key (and a later unlock re-subscribes via startNativeConversations). */
export function stopNativeConversations(): void {
  offIngested?.();
  offIngested = null;
  offConnected?.();
  offConnected = null;
  nativeConversations.value = [];
}
