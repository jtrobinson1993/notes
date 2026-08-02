import { beforeEach, describe, expect, it, vi } from 'vitest';

// Emoji session lifecycle: what unlocking sets up, and that locking really does
// destroy it (blob: URLs hold decrypted emote bytes; the tally is metadata).

const native = vi.hoisted(() => ({
  emoteSearch: vi.fn(),
  emoteGet: vi.fn(),
  emoteCachedList: vi.fn(),
  relayStatus: vi.fn(),
  settingsGet: vi.fn(),
  settingsSet: vi.fn(),
}));
vi.mock('../../src/lib/native', () => native);

import {
  emoteIdFor,
  emoteRelayOrigin,
  isAllowedEmoteUrl,
  registerEmote,
  resolveEmoji,
} from '../../src/lib/emoji';
import { contentEmoteUrl, emoteBudgetSpent } from '../../src/lib/emoji/render';
import { initEmoji, teardownEmoji } from '../../src/lib/emoji/session';
import { emojiUsage, recordEmoteUse } from '../../src/lib/emoji/usage';

const ID = '01F6MEP1ZG000CSNPPXHJPRW1J';

beforeEach(() => {
  vi.clearAllMocks();
  teardownEmoji();
  native.relayStatus.mockResolvedValue({ connected: true, base_url: 'https://relay.test', relay_fp: 'fp' });
  native.emoteCachedList.mockResolvedValue([
    { id: ID, name: 'partyblob', width: 32, height: 32, animated: false, lastUsedAt: 1 },
  ]);
  native.settingsGet.mockResolvedValue(null);
  native.settingsSet.mockResolvedValue(undefined);
  native.emoteGet.mockImplementation((id: string, name: string) =>
    Promise.resolve({ id, name, mime: 'image/webp', width: 32, height: 32, animated: false, bytes: [1], fetched: false }),
  );
});

describe('initEmoji', () => {
  it('pins the connected relay as the only remote emote origin', async () => {
    await initEmoji();

    expect(emoteRelayOrigin()).toBe('https://relay.test');
    expect(isAllowedEmoteUrl('https://relay.test/api/relay/emote/sig/x.webp')).toBe(true);
    expect(isAllowedEmoteUrl('https://cdn.7tv.app/x.webp')).toBe(false);
  });

  it('leaves no origin pinned when the relay is unknown', async () => {
    native.relayStatus.mockRejectedValue(new Error('not connected'));
    await initEmoji();

    expect(emoteRelayOrigin()).toBeNull();
    expect(isAllowedEmoteUrl('https://relay.test/x.webp')).toBe(false);
  });

  it('learns the ids of cached emotes, so content resolves with no search', async () => {
    await initEmoji();
    expect(emoteIdFor('partyblob')).toBe(ID);

    const url = await contentEmoteUrl('partyblob', 'msg-1');
    expect(native.emoteSearch).not.toHaveBeenCalled();
    expect(url).toMatch(/^blob:/);
    // A cache hit costs the message nothing: offline emoji stay unlimited.
    expect(emoteBudgetSpent('msg-1')).toBe(0);
  });

  it('survives a locked vault (no cache, no relay) without throwing', async () => {
    native.relayStatus.mockRejectedValue(new Error('locked'));
    native.emoteCachedList.mockRejectedValue(new Error('locked'));
    native.settingsGet.mockRejectedValue(new Error('locked'));
    await expect(initEmoji()).resolves.toBeUndefined();
  });
});

describe('teardownEmoji', () => {
  it('drops the registry, the budgets, the tally and the pinned origin', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    await initEmoji();
    const url = await contentEmoteUrl('partyblob', 'msg-1');
    registerEmote('other', 'https://relay.test/api/relay/emote/sig/y.webp');
    recordEmoteUse('partyblob');

    teardownEmoji();

    expect(revoke).toHaveBeenCalledWith(url);
    expect(resolveEmoji('partyblob')).toBeNull();
    expect(resolveEmoji('other')).toBeNull();
    expect(emoteIdFor('partyblob')).toBeNull();
    expect(emoteBudgetSpent('msg-1')).toBe(0);
    expect(emojiUsage.map).toEqual({});
    expect(emoteRelayOrigin()).toBeNull();
  });
});
