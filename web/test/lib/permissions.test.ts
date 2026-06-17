import { describe, expect, it } from 'vitest';
import { canManageMembers } from '@notes/shared';

describe('canManageMembers', () => {
  it('owners and admins can manage; plain members cannot', () => {
    expect(canManageMembers('owner')).toBe(true);
    expect(canManageMembers('admin')).toBe(true);
    expect(canManageMembers('member')).toBe(false);
  });
});
