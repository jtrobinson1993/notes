import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  attachmentUpload: vi.fn(),
  attachmentDownload: vi.fn(),
  settingGet: vi.fn(),
  settingPut: vi.fn(),
}));
vi.mock('../../src/lib/api', () => ({ api }));

const MK = new Uint8Array(32).fill(7);
vi.mock('../../src/stores/session', () => ({ useSessionStore: () => ({ mk: MK }) }));

import { resolveEmoji, clearCustomEmoji } from '../../src/lib/emoji';
import {
  addCustomEmoji,
  customEmoji,
  customEmojiForText,
  loadCustomEmoji,
  registerEmbeddedEmoji,
  resetCustomEmoji,
} from '../../src/lib/emoji/custom';

function file(name: string, type: string, bytes: Uint8Array): File {
  return new File([bytes as BlobPart], name, { type });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCustomEmoji();
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:fake';
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  api.settingPut.mockResolvedValue({ updatedAt: 1 });
  api.attachmentUpload.mockResolvedValue({ id: 'e1', size: 3 });
});
afterEach(() => {
  resetCustomEmoji();
  clearCustomEmoji();
});

describe('custom emoji palette', () => {
  it('adds: encrypts + uploads ciphertext, registers for rendering, persists encrypted', async () => {
    await addCustomEmoji('catpls', file('c.png', 'image/png', new Uint8Array([1, 2, 3])));

    expect(api.attachmentUpload).toHaveBeenCalledOnce();
    expect(customEmoji.items.map((e) => e.name)).toEqual(['catpls']);
    expect(resolveEmoji('catpls')).toBe('blob:fake');

    // Persisted blob is master-key-encrypted (not the plaintext palette).
    expect(api.settingPut).toHaveBeenCalledOnce();
    const [key, data] = api.settingPut.mock.calls[0];
    expect(key).toBe('chat-emoji');
    expect(data).not.toContain('catpls');
  });

  it('rejects a duplicate name and an invalid name', async () => {
    await addCustomEmoji('dupe', file('a.png', 'image/png', new Uint8Array([1])));
    await expect(addCustomEmoji('dupe', file('b.png', 'image/png', new Uint8Array([2])))).rejects.toThrow(/already used/);
    await expect(addCustomEmoji('has space', file('c.png', 'image/png', new Uint8Array([3])))).rejects.toThrow(/2.40/);
  });

  it('customEmojiForText embeds only the shortcodes actually used', async () => {
    await addCustomEmoji('catpls', file('c.png', 'image/png', new Uint8Array([1, 2, 3])));
    const map = customEmojiForText('hi :catpls: and :not_in_palette:');
    expect(Object.keys(map ?? {})).toEqual(['catpls']);
    expect(customEmojiForText('no shortcodes here')).toBeUndefined();
  });

  it('round-trips through the encrypted setting and re-registers on load', async () => {
    await addCustomEmoji('catpls', file('c.png', 'image/png', new Uint8Array([9, 9, 9])));
    const persisted = api.settingPut.mock.calls[0][1] as string;
    const uploadedCiphertext = api.attachmentUpload.mock.calls[0][0] as Uint8Array;

    // Simulate a fresh session: clear in-memory state, serve the stored blob.
    resetCustomEmoji();
    clearCustomEmoji();
    expect(resolveEmoji('catpls')).toBeNull();
    api.settingGet.mockResolvedValue({ data: persisted, updatedAt: 1 });
    api.attachmentDownload.mockResolvedValue(uploadedCiphertext);

    await loadCustomEmoji();
    expect(customEmoji.items.map((e) => e.name)).toEqual(['catpls']);
    expect(resolveEmoji('catpls')).toBe('blob:fake');
  });

  it('registerEmbeddedEmoji makes a received emoji renderable', async () => {
    // Build a ref the way a sender would, then receive it.
    await addCustomEmoji('frompal', file('c.png', 'image/png', new Uint8Array([5, 5])));
    const ref = customEmoji.items[0]!.ref;
    const ciphertext = api.attachmentUpload.mock.calls[0][0] as Uint8Array;
    resetCustomEmoji();
    clearCustomEmoji();
    api.attachmentDownload.mockResolvedValue(ciphertext);

    await registerEmbeddedEmoji({ frompal: ref });
    expect(resolveEmoji('frompal')).toBe('blob:fake');
  });
});
