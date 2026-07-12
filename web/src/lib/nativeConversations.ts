// Shared native conversation list for the app sidebar (native shell). Mirrors the
// legacy layout: DMs + groups show in the sidebar above Notes, each with a title
// + icon-initial derived from the member/group name. Kept as a small reactive
// module (not a full store) so both the sidebar and the chat view can read it and
// it refreshes on every mailbox drain.

import { ref } from 'vue';
import { isNative } from './native';
import { listDms } from './nativeDm';
import { listGroups } from './nativeGroup';
import { onMailIngested } from './nativeRelay';

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
}

export const nativeConversations = ref<NativeConvItem[]>([]);

function initial(s: string): string {
  return (s.trim()[0] ?? '?').toUpperCase();
}

export async function refreshNativeConversations(): Promise<void> {
  if (!isNative) return;
  const [dms, groups] = await Promise.all([listDms(), listGroups()]);
  nativeConversations.value = [
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
      };
    }),
  ];
}

let started = false;
/** Begin keeping the sidebar list current: load once + refresh on each drain. */
export function startNativeConversations(): void {
  if (!isNative || started) return;
  started = true;
  void refreshNativeConversations();
  onMailIngested(() => void refreshNativeConversations());
}
