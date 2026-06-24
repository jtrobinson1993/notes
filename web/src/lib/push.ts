import { api } from './api';

// Browser Web Push: turn the PWA's service-worker subscription on/off and keep
// the server in sync. Notifications are content-free ("New message") — see
// spec/notifications.md. All functions are no-ops / report unsupported when the
// platform lacks service workers or the Push API (e.g. iOS Safari pre-16.4, or
// a non-installed context that doesn't grant push).

export type PushState = 'unsupported' | 'denied' | 'off' | 'on';

export function isPushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** Standard base64url(VAPID public key) -> bytes for applicationServerKey.
 * Backed by an explicit ArrayBuffer so the type is a plain BufferSource.
 * Exported for tests. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function readyRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null;
  try {
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

function toInput(sub: PushSubscription): { endpoint: string; keys: { p256dh: string; auth: string } } | null {
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) return null;
  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}

/** Current state: unsupported, permission denied, or whether a subscription
 * exists. Cheap to call on settings mount. */
export async function pushState(): Promise<PushState> {
  if (!isPushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await readyRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return sub ? 'on' : 'off';
}

/** Request permission (if needed), subscribe, and register with the server.
 * Returns the resulting state. Throws only on an unexpected server error. */
export async function enablePush(): Promise<PushState> {
  if (!isPushSupported()) return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';

  const { publicKey } = await api.pushKey();
  if (!publicKey) return 'off'; // server has push disabled (no VAPID keys)

  const reg = await readyRegistration();
  if (!reg) return 'unsupported';

  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  const input = toInput(sub);
  if (!input) return 'off';
  await api.pushSubscribe(input);
  return 'on';
}

/** localStorage flag recording that we've already shown the first-open
 *  notification opt-in on this device (set whichever option the user picks, so
 *  the prompt never nags again). */
export const NOTIF_OPTIN_SEEN_KEY = 'notes:notif-optin-seen';

/** Whether to offer the first-open opt-in prompt. Only when the platform
 *  supports push, the user hasn't decided at the OS level yet (permission still
 *  `default`), the server can actually deliver (a VAPID key exists), and we
 *  haven't already asked on this device. Pure so it's unit-testable. */
export function shouldOfferPush(opts: {
  supported: boolean;
  permission: NotificationPermission;
  hasServerKey: boolean;
  seen: boolean;
}): boolean {
  return opts.supported && opts.permission === 'default' && opts.hasServerKey && !opts.seen;
}

/** Unsubscribe locally and tell the server to forget the endpoint. */
export async function disablePush(): Promise<PushState> {
  const reg = await readyRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    const endpoint = sub.endpoint;
    try {
      await sub.unsubscribe();
    } catch {
      /* best effort */
    }
    try {
      await api.pushUnsubscribe(endpoint);
    } catch {
      /* server prunes dead subscriptions on send anyway */
    }
  }
  return isPushSupported() ? 'off' : 'unsupported';
}
