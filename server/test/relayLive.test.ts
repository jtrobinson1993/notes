import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { makeApp, seedAuthedUser, type TestApp } from '../../test/helpers/server.js';

let t: TestApp;
let port: number;

beforeEach(async () => {
  t = await makeApp();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  port = (t.app.server.address() as AddressInfo).port;
});
afterEach(() => t.cleanup());

/** Enroll a device for an authed user and mint a short-lived bearer token. */
async function enrollDevice(cookie: string): Promise<{ pubKey: string; bearer: string }> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const pubKey = spki.subarray(spki.length - 32).toString('base64');
  await t.app.inject({ method: 'POST', url: '/api/relay/devices', headers: { cookie }, payload: { pubKey } });
  const info = await t.app.inject({ method: 'GET', url: '/api/relay/info' });
  const challenge = await t.app.inject({ method: 'POST', url: '/api/relay/auth/challenge' });
  const nonce = challenge.json().nonce as string;
  const signature = edSign(
    null,
    Buffer.from(`${nonce}|${info.json().identityFingerprint as string}`),
    privateKey,
  ).toString('base64');
  const token = await t.app.inject({
    method: 'POST',
    url: '/api/relay/auth/token',
    payload: { pubKey, nonce, signature },
  });
  return { pubKey, bearer: token.json().token as string };
}

/** A relay-WS client that records frames and resolves on demand. */
class LiveClient {
  ws: WebSocket;
  frames: { type?: string }[] = [];
  closed = false;
  private waiters: { pred: (f: { type?: string }) => boolean; resolve: (f: { type?: string }) => void }[] = [];

  constructor(bearer?: string) {
    const headers: Record<string, string> = {};
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/api/relay/ws`, { headers });
    this.ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      this.frames.push(frame);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(frame)) {
          w.resolve(frame);
          return false;
        }
        return true;
      });
    });
    this.ws.on('close', () => {
      this.closed = true;
    });
  }

  waitFor(pred: (f: { type?: string }) => boolean, ms = 2000): Promise<{ type?: string }> {
    const existing = this.frames.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for frame')), ms);
      this.waiters.push({ pred, resolve: (f) => (clearTimeout(timer), resolve(f)) });
    });
  }

  waitClose(ms = 2000): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for close')), ms);
      this.ws.on('close', () => (clearTimeout(timer), resolve()));
    });
  }

  close(): void {
    this.ws.close();
  }
}

describe('relay live delivery (/api/relay/ws)', () => {
  it('greets an authenticated device', async () => {
    const alice = seedAuthedUser(t.db, { handle: 'Alice#0001' });
    const { bearer } = await enrollDevice(alice.cookie);
    const c = new LiveClient(bearer);
    const hello = await c.waitFor((f) => f.type === 'hello');
    expect(hello).toEqual({ type: 'hello' });
    c.close();
  });

  it('rejects a connection with no bearer token', async () => {
    const c = new LiveClient(undefined);
    await c.waitClose();
    expect(c.frames).toHaveLength(0);
  });

  it('rejects a revoked device token', async () => {
    const alice = seedAuthedUser(t.db, { handle: 'Alice#0001' });
    const { pubKey, bearer } = await enrollDevice(alice.cookie);
    const deviceId = createHash('sha256').update(Buffer.from(pubKey, 'base64')).digest('base64url');
    expect(t.db.revokeRelayDevice(alice.id, deviceId)).toBe(true);
    const c = new LiveClient(bearer);
    await c.waitClose();
    expect(c.frames).toHaveLength(0);
  });

  it('nudges a connected recipient device when a sealed send is enqueued', async () => {
    const alice = seedAuthedUser(t.db, { handle: 'Alice#0001' });
    const { bearer } = await enrollDevice(alice.cookie);

    // Alice registers a delivery-token verifier so a sealed send can target her.
    const deliveryToken = 'delivery-secret-token';
    const verifier = createHash('sha256').update(deliveryToken).digest('base64url');
    await t.app.inject({
      method: 'PUT',
      url: '/api/relay/verifier',
      headers: { authorization: `Bearer ${bearer}` },
      payload: { verifier },
    });

    const c = new LiveClient(bearer);
    await c.waitFor((f) => f.type === 'hello');

    const send = await t.app.inject({
      method: 'POST',
      url: '/api/relay/mailbox/send',
      payload: {
        deliveryToken,
        recipientHandle: 'Alice#0001',
        envelope: Buffer.from('sealed').toString('base64'),
      },
    });
    expect(send.statusCode).toBe(200);

    const mail = await c.waitFor((f) => f.type === 'mail');
    expect(mail).toEqual({ type: 'mail' });
    c.close();
  });

  it('evicts the oldest socket past the per-device cap (4)', async () => {
    const alice = seedAuthedUser(t.db, { handle: 'Alice#0001' });
    const { bearer } = await enrollDevice(alice.cookie);
    const clients: LiveClient[] = [];
    for (let i = 0; i < 4; i++) {
      const c = new LiveClient(bearer);
      await c.waitFor((f) => f.type === 'hello');
      clients.push(c);
    }
    const fifth = new LiveClient(bearer);
    await fifth.waitFor((f) => f.type === 'hello');
    await clients[0]!.waitClose();
    expect(clients[0]!.closed).toBe(true);
    for (const c of clients.slice(1)) c.close();
    fifth.close();
  });
});
