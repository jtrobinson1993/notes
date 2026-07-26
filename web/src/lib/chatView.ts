// The UI's view of one message from the local encrypted log (D11).
//
// This is the v8 shape: identity is the log row's globally-unique id and order
// is the relay delivery stamp. There is no `seq`, `epoch` or wire ciphertext —
// the Rust core opens and verifies envelopes before anything reaches the
// webview, so what arrives here is already plaintext.

import type { MessageAttachment } from './native';
import type { ReplyRef, SystemEvent } from '@notes/shared';

export interface ChatMessageView {
  /** Local-log row id — globally unique, and the dedup/edit/react handle. */
  key: string;
  conversationId: string;
  /** null for a conversation's general channel. */
  channelId: string | null;
  /** The verified sender's contact id; `'self'` for my own messages. */
  senderId: string;
  /** Relay delivery stamp (ms) — the ordering key. */
  sortKey: number;
  /** Decrypted text, or null for a tombstoned (deleted) message. */
  text: string | null;
  attachments: MessageAttachment[];
  replyTo?: ReplyRef;
  /** An inline system notice (member added, …) rendered instead of a bubble. */
  system?: SystemEvent;
  editedAt?: number;
}
