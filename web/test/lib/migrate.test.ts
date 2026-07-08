import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  collectBlobRefs,
  noteBodyToYdocState,
  toImportMessage,
  toImportNote,
} from '../../src/lib/migrate';
import type { AttachmentRef, ChatMessage, MessagePayload, NoteRecord } from '@notes/shared';

const record: NoteRecord = {
  id: 'n1',
  ciphertext: 'x',
  iv: 'x',
  wrappedKey: { ciphertext: 'x', iv: 'x' },
  createdAt: 100,
  updatedAt: 200,
  deleted: false,
};

const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  conversationId: 'c1',
  channelId: 'c1',
  seq: 7,
  senderId: 'u1',
  epoch: 0,
  ciphertext: 'x',
  iv: 'x',
  createdAt: 5000,
  editedAt: null,
  ...over,
});

const payload = (over: Partial<MessagePayload> = {}): MessagePayload => ({
  text: 'hello',
  sentAt: 4990,
  ...over,
});

describe('noteBodyToYdocState', () => {
  it('round-trips the body through a Yjs doc', () => {
    const state = noteBodyToYdocState('# Title\n\nSome **markdown**.');
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Uint8Array.from(state));
    expect(doc.getText('content').toString()).toBe('# Title\n\nSome **markdown**.');
  });
});

describe('toImportNote', () => {
  it('maps timestamps, seeds the doc, and folds tags into search_text', () => {
    const n = toImportNote(record, 'My note', 'body text', ['work', 'urgent']);
    expect(n).toMatchObject({
      id: 'n1',
      title: 'My note',
      search_text: 'body text\nwork urgent',
      created: 100,
      updated: 200,
    });
    expect(n.ydoc_state.length).toBeGreaterThan(0);
  });

  it('omits the tag suffix when there are no tags', () => {
    expect(toImportNote(record, 't', 'body', []).search_text).toBe('body');
  });
});

describe('toImportMessage', () => {
  it('composes a stable legacy id and maps the general channel to null', () => {
    const m = toImportMessage(msg(), payload());
    expect(m).toMatchObject({
      id: 'legacy:c1:7',
      conversation_id: 'c1',
      channel_id: null,
      sender_contact_id: 'u1',
      relay_ts: 5000,
      content: 'hello',
      kind: 'text',
      reply_ref_json: null,
      attachments_json: null,
    });
  });

  it('keeps a distinct channel id and marks system messages', () => {
    const m = toImportMessage(
      msg({ channelId: 'ch9' }),
      payload({ text: '', system: { kind: 'member-added' } as MessagePayload['system'] }),
    );
    expect(m.channel_id).toBe('ch9');
    expect(m.kind).toBe('system');
    expect(m.content).toBeNull();
  });

  it('collects attachment refs including video posters as separate blobs', () => {
    const ref: AttachmentRef = {
      id: 'vid1',
      name: 'clip.mp4',
      type: 'video/mp4',
      size: 999,
      key: 'k',
      iv: 'i',
      poster: { id: 'poster1', key: 'pk', iv: 'pi', type: 'image/webp' },
    };
    const out = collectBlobRefs([ref], 'message', 'legacy:c1:7');
    expect(out.map((p) => p.ref.id)).toEqual(['vid1', 'poster1']);
    expect(out[1]).toMatchObject({ ownerKind: 'message', ownerId: 'legacy:c1:7' });
    expect(collectBlobRefs(undefined, 'note', 'n1')).toEqual([]);
  });

  it('serializes reply refs and attachments', () => {
    const m = toImportMessage(
      msg(),
      payload({
        replyTo: { seq: 3, senderId: 'u2', preview: 'earlier' } as MessagePayload['replyTo'],
        attachments: [{ id: 'a1' }] as unknown as MessagePayload['attachments'],
      }),
    );
    expect(JSON.parse(m.reply_ref_json!)).toMatchObject({ seq: 3 });
    expect(JSON.parse(m.attachments_json!)).toMatchObject({ attachments: [{ id: 'a1' }] });
  });
});
