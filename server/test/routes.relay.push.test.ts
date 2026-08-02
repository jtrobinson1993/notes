import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { enrollDevice as enrollRelayDevice, makeRelayApp, seedUser, type TestApp } from '../../test/helpers/server.js';

// Mock web-push so createPush is "enabled" with fixed keys and sendNotification
// is an assertable spy (no real network to the push endpoint).
const webpush = vi.hoisted(() => ({
  generateVAPIDKeys: () => ({ publicKey: 'VAPID_PUB', privateKey: 'VAPID_PRIV' }),
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn().mockResolvedValue({}),
}));
vi.mock('web-push', () => ({ default: webpush }));

let ctx: TestApp;
afterEach(async () => {
  if (ctx) await ctx.cleanup();
  vi.clearAllMocks();
});

async function deviceBearer(userId: string): Promise<string> {
  const { token } = await enrollRelayDevice(ctx.app, ctx.db, { userId });
  return token; // raw token; call sites add the `Bearer ` prefix
}

const SUB = { endpoint: 'https://push.example/abc', p256dh: 'p256', auth: 'authk' };

describe('v8 content-free push (D7)', () => {
  it('serves the VAPID key and registers/unregisters a subscription (device-token authed)', async () => {
    ctx = await makeRelayApp();
    const alice = seedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice);

    expect((await ctx.app.inject({ method: 'GET', url: '/api/relay/push/key' })).json().publicKey).toBe('VAPID_PUB');

    // No device token → 401.
    expect((await ctx.app.inject({ method: 'POST', url: '/api/relay/push/subscribe', payload: SUB })).statusCode).toBe(401);

    const sub = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/push/subscribe',
      headers: { authorization: `Bearer ${bearer}` },
      payload: SUB,
    });
    expect(sub.statusCode).toBe(200);
    expect(ctx.db.listPushSubscriptions(alice)).toHaveLength(1);

    await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/push/unsubscribe',
      headers: { authorization: `Bearer ${bearer}` },
      payload: { endpoint: SUB.endpoint },
    });
    expect(ctx.db.listPushSubscriptions(alice)).toHaveLength(0);
  });

  it('sends a content-free {type:mail} wake to an offline recipient on mailbox send', async () => {
    ctx = await makeRelayApp();
    const alice = seedUser(ctx.db, { handle: 'Alice#0001' });
    const bearer = await deviceBearer(alice);
    // Alice registers a delivery verifier (so a sealed send targets her) + a push sub.
    const deliveryToken = 'deliv-secret';
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/relay/verifier',
      headers: { authorization: `Bearer ${bearer}` },
      payload: { verifier: createHash('sha256').update(deliveryToken).digest('base64url') },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/push/subscribe',
      headers: { authorization: `Bearer ${bearer}` },
      payload: SUB,
    });

    const send = await ctx.app.inject({
      method: 'POST',
      url: '/api/relay/mailbox/send',
      payload: { deliveryToken, recipientHandle: 'Alice#0001', envelope: Buffer.from('sealed').toString('base64') },
    });
    expect(send.statusCode).toBe(200);

    // Alice's device isn't connected (no live WS) → she gets a content-free wake.
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    const [subscription, body] = webpush.sendNotification.mock.calls[0]!;
    expect(subscription.endpoint).toBe(SUB.endpoint);
    expect(JSON.parse(body as string)).toEqual({ type: 'mail' }); // no content / routing
  });
});
