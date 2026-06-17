import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/lib/api', () => ({
  api: {
    pushKey: vi.fn(() =>
      Promise.resolve({
        // A realistic 87-char base64url VAPID public key (65 raw bytes).
        publicKey: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7Dk',
      }),
    ),
    pushSubscribe: vi.fn(() => Promise.resolve({ ok: true })),
    pushUnsubscribe: vi.fn(() => Promise.resolve({ ok: true })),
  },
}));

import { api } from '../../src/lib/api';
import { urlBase64ToUint8Array, isPushSupported, pushState, enablePush, disablePush } from '../../src/lib/push';

const apiMock = api as unknown as {
  pushKey: ReturnType<typeof vi.fn>;
  pushSubscribe: ReturnType<typeof vi.fn>;
  pushUnsubscribe: ReturnType<typeof vi.fn>;
};

// --- browser surface stubs -------------------------------------------------
function installPushEnv(opts: {
  permission?: NotificationPermission;
  existingSub?: unknown;
  subscribed?: boolean;
} = {}) {
  const sub = {
    endpoint: 'https://push.example.com/sub/xyz',
    toJSON: () => ({ endpoint: 'https://push.example.com/sub/xyz', keys: { p256dh: 'P', auth: 'A' } }),
    unsubscribe: vi.fn(() => Promise.resolve(true)),
  };
  const current = opts.subscribed ? sub : opts.existingSub === undefined ? null : opts.existingSub;
  const pushManager = {
    getSubscription: vi.fn(() => Promise.resolve(current)),
    subscribe: vi.fn(() => Promise.resolve(sub)),
  };
  const registration = { pushManager };

  Object.defineProperty(globalThis, 'navigator', {
    value: { serviceWorker: { ready: Promise.resolve(registration) } },
    configurable: true,
  });
  (globalThis as Record<string, unknown>).PushManager = function () {};
  (globalThis as Record<string, unknown>).Notification = {
    permission: opts.permission ?? 'default',
    requestPermission: vi.fn(() => Promise.resolve(opts.permission ?? 'granted')),
  };
  return { sub, pushManager };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  delete (globalThis as Record<string, unknown>).PushManager;
  delete (globalThis as Record<string, unknown>).Notification;
});

describe('urlBase64ToUint8Array', () => {
  it('decodes base64url (with - and _) and pads correctly', () => {
    // bytes [251, 255, 190] => base64 "+/++" => base64url "-_--"
    const out = urlBase64ToUint8Array('-_--');
    expect(Array.from(out)).toEqual([251, 255, 190]);
  });

  it('round-trips an empty string to an empty array', () => {
    expect(urlBase64ToUint8Array('').length).toBe(0);
  });
});

describe('isPushSupported', () => {
  it('is false when the platform lacks the Push API', () => {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    expect(isPushSupported()).toBe(false);
  });
});

describe('enablePush', () => {
  it('subscribes and registers with the server when permission is granted', async () => {
    const { pushManager } = installPushEnv({ permission: 'granted' });
    const state = await enablePush();
    expect(state).toBe('on');
    expect(pushManager.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true, applicationServerKey: expect.anything() }),
    );
    expect(apiMock.pushSubscribe).toHaveBeenCalledWith({
      endpoint: 'https://push.example.com/sub/xyz',
      keys: { p256dh: 'P', auth: 'A' },
    });
  });

  it('reuses an existing subscription instead of re-subscribing', async () => {
    const existing = {
      endpoint: 'https://push.example.com/sub/old',
      toJSON: () => ({ endpoint: 'https://push.example.com/sub/old', keys: { p256dh: 'P2', auth: 'A2' } }),
    };
    const { pushManager } = installPushEnv({ permission: 'granted', existingSub: existing });
    const state = await enablePush();
    expect(state).toBe('on');
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(apiMock.pushSubscribe).toHaveBeenCalledWith({
      endpoint: 'https://push.example.com/sub/old',
      keys: { p256dh: 'P2', auth: 'A2' },
    });
  });

  it('returns denied and does not subscribe when permission is refused', async () => {
    const { pushManager } = installPushEnv({ permission: 'denied' });
    const state = await enablePush();
    expect(state).toBe('denied');
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(apiMock.pushSubscribe).not.toHaveBeenCalled();
  });
});

describe('pushState', () => {
  it('reports on when a subscription already exists', async () => {
    installPushEnv({ permission: 'granted', existingSub: { endpoint: 'x' } });
    expect(await pushState()).toBe('on');
  });

  it('reports denied regardless of subscription', async () => {
    installPushEnv({ permission: 'denied' });
    expect(await pushState()).toBe('denied');
  });
});

describe('disablePush', () => {
  it('unsubscribes locally and tells the server to forget the endpoint', async () => {
    const { sub } = installPushEnv({ permission: 'granted', subscribed: true });
    const state = await disablePush();
    expect(state).toBe('off');
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(apiMock.pushUnsubscribe).toHaveBeenCalledWith('https://push.example.com/sub/xyz');
  });
});
