import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import webpush from 'web-push';
import type { PushPayload } from '@notes/shared';
import type { Config } from './config.js';
import type { DB } from './db.js';
import type { Realtime } from './realtime.js';

// Web Push delivery. The server is crypto-oblivious, so a push NEVER carries
// message content — only a routing hint ({ type:'message', conversationId }).
// The service worker shows a generic "New message" and, on click, opens the app,
// which then connects and decrypts normally. This mirrors how E2EE messengers
// (e.g. Signal) keep notifications content-free. See spec/notifications.md.

export interface Push {
  /** True when VAPID keys are configured/derived and pushes can be sent. */
  readonly enabled: boolean;
  /** The VAPID public key the browser needs to create a subscription, or null. */
  readonly publicKey: string | null;
  /** Push a content-free ping to every member without a live socket. */
  notifyNewMessage(conversationId: string, senderId: string, memberIds: string[]): void;
  /** Push a content-free incoming-call ping to callees without a live socket
   *  (online devices are rung over the WebSocket). */
  notifyCall(conversationId: string, callerId: string, calleeIds: string[]): void;
}

const NOOP: Push = { enabled: false, publicKey: null, notifyNewMessage() {}, notifyCall() {} };

/** Resolve VAPID keys: explicit env vars win; otherwise generate once and
 * persist to the data dir so the keypair (and clients' existing subscriptions)
 * survives restarts. */
function resolveVapidKeys(config: Config): { publicKey: string; privateKey: string } | null {
  const envPub = process.env.VAPID_PUBLIC_KEY?.trim();
  const envPriv = process.env.VAPID_PRIVATE_KEY?.trim();
  if (envPub && envPriv) return { publicKey: envPub, privateKey: envPriv };
  if (envPub || envPriv) return null; // half-configured — treat as disabled

  const path = join(config.dataDir, 'vapid.json');
  if (existsSync(path)) {
    try {
      const j = JSON.parse(readFileSync(path, 'utf8')) as Partial<{ publicKey: string; privateKey: string }>;
      if (j.publicKey && j.privateKey) return { publicKey: j.publicKey, privateKey: j.privateKey };
    } catch {
      /* corrupt — regenerate below */
    }
  }
  const keys = webpush.generateVAPIDKeys();
  writeFileSync(path, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

export function createPush(db: DB, config: Config, realtime: Realtime): Push {
  const keys = resolveVapidKeys(config);
  if (!keys) return NOOP;

  const subject = process.env.VAPID_SUBJECT?.trim() || `mailto:admin@${config.rpId}`;
  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);

  function notifyNewMessage(conversationId: string, senderId: string, memberIds: string[]): void {
    const payload: PushPayload = { type: 'message', conversationId };
    const body = JSON.stringify(payload);
    for (const uid of memberIds) {
      if (uid === senderId) continue;
      if (realtime.isOnline(uid)) continue; // a live socket already delivered it
      for (const sub of db.listPushSubscriptions(uid)) {
        webpush
          .sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body)
          .catch((err: { statusCode?: number }) => {
            // 404/410 => the browser dropped this subscription; prune it.
            if (err?.statusCode === 404 || err?.statusCode === 410) {
              db.deletePushSubscription(uid, sub.endpoint);
            }
          });
      }
    }
  }

  function notifyCall(conversationId: string, callerId: string, calleeIds: string[]): void {
    const body = JSON.stringify({ type: 'call', conversationId } satisfies PushPayload);
    for (const uid of calleeIds) {
      if (uid === callerId) continue;
      if (realtime.isOnline(uid)) continue; // a live socket rings them over WS
      for (const sub of db.listPushSubscriptions(uid)) {
        webpush
          .sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body)
          .catch((err: { statusCode?: number }) => {
            if (err?.statusCode === 404 || err?.statusCode === 410) db.deletePushSubscription(uid, sub.endpoint);
          });
      }
    }
  }

  return { enabled: true, publicKey: keys.publicKey, notifyNewMessage, notifyCall };
}
