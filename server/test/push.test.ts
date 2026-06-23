import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import webpush from 'web-push';
import { createPush } from '../src/push.js';
import type { Realtime } from '../src/realtime.js';
import { makeConfig, makeDb, seedUser, type TestDb } from '../../test/helpers/server.js';

vi.mock('web-push', () => ({
  default: {
    generateVAPIDKeys: vi.fn(() => ({ publicKey: 'GEN_PUB', privateKey: 'GEN_PRIV' })),
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(() => Promise.resolve()),
  },
}));

const mock = webpush as unknown as {
  generateVAPIDKeys: ReturnType<typeof vi.fn>;
  setVapidDetails: ReturnType<typeof vi.fn>;
  sendNotification: ReturnType<typeof vi.fn>;
};

/** A realtime stand-in whose only relevant behavior is presence. */
function fakeRealtime(online: Set<string>): Realtime {
  return {
    isOnline: (id: string) => online.has(id),
    register() {},
    sendToUser() {},
    sendToUsers() {},
  };
}

let t: TestDb;
beforeEach(() => {
  t = makeDb();
  vi.clearAllMocks();
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
});
afterEach(() => t.cleanup());

const flush = () => new Promise((r) => setImmediate(r));

describe('createPush — VAPID key resolution', () => {
  it('uses explicit env keys when both are set', () => {
    process.env.VAPID_PUBLIC_KEY = 'ENV_PUB';
    process.env.VAPID_PRIVATE_KEY = 'ENV_PRIV';
    const push = createPush(t.db, makeConfig(t.dir), fakeRealtime(new Set()));
    expect(push.enabled).toBe(true);
    expect(push.publicKey).toBe('ENV_PUB');
    expect(mock.setVapidDetails).toHaveBeenCalledWith(expect.any(String), 'ENV_PUB', 'ENV_PRIV');
    expect(mock.generateVAPIDKeys).not.toHaveBeenCalled();
  });

  it('generates + persists a keypair when no env keys are set', () => {
    const push = createPush(t.db, makeConfig(t.dir), fakeRealtime(new Set()));
    expect(push.publicKey).toBe('GEN_PUB');
    expect(existsSync(join(t.dir, 'vapid.json'))).toBe(true);
    // A second instance reuses the persisted keys (no second generation).
    createPush(t.db, makeConfig(t.dir), fakeRealtime(new Set()));
    expect(mock.generateVAPIDKeys).toHaveBeenCalledTimes(1);
  });

  it('is disabled when only one half of the keypair is configured', () => {
    process.env.VAPID_PUBLIC_KEY = 'ENV_PUB';
    const push = createPush(t.db, makeConfig(t.dir), fakeRealtime(new Set()));
    expect(push.enabled).toBe(false);
    expect(push.publicKey).toBeNull();
  });
});

describe('notifyNewMessage', () => {
  function seedWithSub(online: Set<string>) {
    const sender = seedUser(t.db, {});
    const recipient = seedUser(t.db, {});
    t.db.addPushSubscription({ userId: recipient, endpoint: 'https://push.example/abc', p256dh: 'p', auth: 'a' });
    const push = createPush(t.db, makeConfig(t.dir), fakeRealtime(online));
    return { sender, recipient, push };
  }

  it('pushes to an offline recipient, skipping the sender', () => {
    const { sender, recipient, push } = seedWithSub(new Set());
    push.notifyNewMessage('conv1', sender, [sender, recipient]);
    expect(mock.sendNotification).toHaveBeenCalledTimes(1);
    const [sub, body] = mock.sendNotification.mock.calls[0]!;
    expect(sub.endpoint).toBe('https://push.example/abc');
    expect(JSON.parse(body)).toEqual({ type: 'message', conversationId: 'conv1' });
  });

  it('does NOT push to a recipient with a live socket', () => {
    const { sender, recipient, push } = seedWithSub(new Set([/* recipient online */]));
    push.notifyNewMessage('conv1', sender, [sender, recipient]);
    // recipient offline above -> 1 send; now make them online:
    mock.sendNotification.mockClear();
    const online = new Set([recipient]);
    const push2 = createPush(t.db, makeConfig(t.dir), fakeRealtime(online));
    push2.notifyNewMessage('conv1', sender, [sender, recipient]);
    expect(mock.sendNotification).not.toHaveBeenCalled();
  });

  it('prunes a subscription the push service reports as gone (410)', async () => {
    const { sender, recipient, push } = seedWithSub(new Set());
    mock.sendNotification.mockReturnValueOnce(Promise.reject({ statusCode: 410 }));
    push.notifyNewMessage('conv1', sender, [sender, recipient]);
    await flush();
    expect(t.db.listPushSubscriptions(recipient)).toHaveLength(0);
  });

  it('keeps the subscription on a transient (500) error', async () => {
    const { sender, recipient, push } = seedWithSub(new Set());
    mock.sendNotification.mockReturnValueOnce(Promise.reject({ statusCode: 500 }));
    push.notifyNewMessage('conv1', sender, [sender, recipient]);
    await flush();
    expect(t.db.listPushSubscriptions(recipient)).toHaveLength(1);
  });
});
