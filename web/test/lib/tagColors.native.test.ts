import { beforeEach, describe, expect, it, vi } from 'vitest';

// Native shell: tag colors are keyed BY TAG NAME, so the blob belongs in the
// encrypted vault — never in plaintext localStorage (there is no server either).
const vault = vi.hoisted(() => new Map<string, string>());
const native = vi.hoisted(() => ({
  isNative: true,
  settingsGet: vi.fn(async (k: string) => vault.get(k) ?? null),
  settingsSet: vi.fn(async (k: string, v: string) => {
    vault.set(k, v);
  }),
}));
vi.mock('../../src/lib/native', () => native);

const api = vi.hoisted(() => ({ settingGet: vi.fn(), settingPut: vi.fn() }));
vi.mock('../../src/lib/api', () => ({ api }));
vi.mock('../../src/stores/session', () => ({ useSessionStore: () => ({ mk: null }) }));

import { clearTagColor, loadTagColors, setTagColor, tagColor } from '../../src/lib/tagColors';

beforeEach(() => {
  vault.clear();
  localStorage.clear();
  vi.clearAllMocks();
});

describe('tagColors (native shell)', () => {
  it('writes colors to the encrypted vault, never to localStorage or the server', async () => {
    setTagColor('#taxes', '#ff0000');
    await vi.waitFor(() => expect(native.settingsSet).toHaveBeenCalled(), { timeout: 3000 });

    expect(api.settingPut).not.toHaveBeenCalled();
    expect(localStorage.getItem('notes:tag-colors')).toBeNull(); // no tag names in the clear
    expect(JSON.parse(vault.get('tag-colors')!)).toEqual({ '#taxes': '#ff0000' });
    expect(tagColor('#taxes')).toBe('#ff0000');

    clearTagColor('#taxes');
    await vi.waitFor(() => expect(JSON.parse(vault.get('tag-colors')!)).toEqual({}), { timeout: 3000 });
  });

  it('loads the stored colors back out of the vault', async () => {
    vault.set('tag-colors', JSON.stringify({ '#work': '#00ff00' }));
    await loadTagColors();
    expect(tagColor('#work')).toBe('#00ff00');
    expect(native.settingsGet).toHaveBeenCalledWith('tag-colors');
  });
});
