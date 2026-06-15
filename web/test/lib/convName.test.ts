import { describe, expect, it } from 'vitest';
import type { Conversation, ConversationMember } from '@notes/shared';
import { conversationInitial, conversationTitle } from '../../src/lib/convName';

function member(userId: string, displayName: string): ConversationMember {
  return { userId, displayName, publicKey: null, nameColor: null };
}

function conv(kind: Conversation['kind'], members: ConversationMember[]): Conversation {
  return {
    id: 'c1',
    kind,
    members,
    sealedKey: { epk: '', iv: '', ct: '' },
    epoch: 0,
    lastSeq: 0,
    lastReadSeq: 0,
    createdAt: 0,
    parentId: null,
    parentSeq: null,
  };
}

const ME = 'me';

describe('conversationTitle', () => {
  it('shows the other person for a DM', () => {
    const c = conv('dm', [member(ME, 'Me'), member('u2', 'Alice')]);
    expect(conversationTitle(c, ME)).toBe('Alice');
  });

  it('joins the other members for a group', () => {
    const c = conv('group', [member(ME, 'Me'), member('u2', 'Alice'), member('u3', 'Bob')]);
    expect(conversationTitle(c, ME)).toBe('Alice, Bob');
  });

  it('labels threads generically', () => {
    const c = conv('thread', [member(ME, 'Me'), member('u2', 'Alice')]);
    expect(conversationTitle(c, ME)).toBe('Thread');
  });

  it('falls back to a label when a group has no other members', () => {
    const c = conv('group', [member(ME, 'Me')]);
    expect(conversationTitle(c, ME)).toBe('Group');
  });

  it('derives an uppercase initial from the title', () => {
    const c = conv('dm', [member(ME, 'Me'), member('u2', 'alice')]);
    expect(conversationInitial(c, ME)).toBe('A');
  });
});
