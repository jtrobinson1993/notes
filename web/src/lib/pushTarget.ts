import type { PushPayload } from '@notes/shared';

/**
 * Build the in-app path a push notification should open. Pure so the service
 * worker (`sw.ts`) and the running app (soft navigation) agree on the
 * destination, and so it's unit-testable.
 *
 * - `message`: opens the conversation, adding the channel segment only when it
 *   differs from the conversation (the general channel is the bare path). A
 *   `?m=<seq>` scrolls to the message; a `?thread=<parentSeq>` opens that thread
 *   panel (the message lives inside the thread).
 * - `call`: opens the conversation so the in-call UI can take over.
 * - anything unrecognised falls back to the app root.
 */
export function pushTargetUrl(payload: Partial<PushPayload> | undefined | null): string {
  if (!payload || !payload.conversationId) return '/';
  if (payload.type === 'call') return `/chat/${payload.conversationId}`;
  if (payload.type !== 'message') return '/';

  const base = `/chat/${payload.conversationId}`;
  const path =
    payload.channelId && payload.channelId !== payload.conversationId
      ? `${base}/${payload.channelId}`
      : base;
  const params = new URLSearchParams();
  if (payload.threadParentSeq != null) params.set('thread', String(payload.threadParentSeq));
  if (payload.seq != null) params.set('m', String(payload.seq));
  const q = params.toString();
  return q ? `${path}?${q}` : path;
}
