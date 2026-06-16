import { describe, expect, it } from 'vitest';
import { canManageMembers } from '@notes/shared';

describe('canManageMembers', () => {
  it('owner can always manage', () => {
    for (const policy of ['owner', 'admins', 'open'] as const) {
      expect(canManageMembers(policy, 'owner')).toBe(true);
    }
  });

  it('admins can manage only under admins/open policy', () => {
    expect(canManageMembers('owner', 'admin')).toBe(false);
    expect(canManageMembers('admins', 'admin')).toBe(true);
    expect(canManageMembers('open', 'admin')).toBe(true);
  });

  it('plain members can manage only under the open policy', () => {
    expect(canManageMembers('owner', 'member')).toBe(false);
    expect(canManageMembers('admins', 'member')).toBe(false);
    expect(canManageMembers('open', 'member')).toBe(true);
  });
});
