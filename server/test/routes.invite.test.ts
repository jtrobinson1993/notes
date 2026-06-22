import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, seedUser, type TestApp } from '../../test/helpers/server.js';

// GET /api/invite/:token — the non-consuming validity check the invite page uses
// to redirect an already-redeemed or expired link to login instead of re-showing
// the invited-user signup flow.

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(() => t.cleanup());

function status(token: string) {
  return t.app.inject({ method: 'GET', url: `/api/invite/${token}` });
}

const HOUR = 3_600_000;

describe('GET /api/invite/:token', () => {
  it('reports a fresh, unused invite as valid', async () => {
    const admin = seedUser(t.db, { role: 'admin' });
    t.db.createInvite({ id: 'i1', token: 'fresh', createdBy: admin, expiresAt: Date.now() + HOUR });

    const res = await status('fresh');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: true });
  });

  it('reports a used invite as invalid (the reported reuse bug)', async () => {
    const admin = seedUser(t.db, { role: 'admin' });
    const joiner = seedUser(t.db);
    t.db.createInvite({ id: 'i2', token: 'used', createdBy: admin, expiresAt: Date.now() + HOUR });
    t.db.markInviteUsed('i2', joiner);

    expect((await status('used')).json()).toEqual({ valid: false });
  });

  it('reports an expired invite as invalid', async () => {
    const admin = seedUser(t.db, { role: 'admin' });
    t.db.createInvite({ id: 'i3', token: 'old', createdBy: admin, expiresAt: Date.now() - 1 });

    expect((await status('old')).json()).toEqual({ valid: false });
  });

  it('reports an unknown token as invalid (no detail leaked)', async () => {
    seedUser(t.db, { role: 'admin' });
    expect((await status('nope')).json()).toEqual({ valid: false });
  });

  it('treats any token as valid before first-run setup (no users yet)', async () => {
    // No invite required until the first account exists; the setup flow handles it.
    expect((await status('whatever')).json()).toEqual({ valid: true });
  });
});
