import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { enrollDevice as enrollRelayDevice, makeRelayApp, seedUser, type TestApp } from '../../test/helpers/server.js';

let t: TestApp;
let port: number;

beforeEach(async () => {
  t = await makeRelayApp();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  port = (t.app.server.address() as AddressInfo).port;
});
afterEach(() => t.cleanup());

async function enrollDevice(userId: string): Promise<string> {
  const { token } = await enrollRelayDevice(t.app, t.db, { userId });
  return token;
}

interface Frame {
  type?: string;
  callId?: string;
  payload?: unknown;
  peers?: number;
  error?: string;
}

class VoiceClient {
  ws: WebSocket;
  frames: Frame[] = [];
  closed = false;
  private waiters: { pred: (f: Frame) => boolean; resolve: (f: Frame) => void; timer: NodeJS.Timeout }[] = [];

  constructor(bearer?: string) {
    const headers: Record<string, string> = {};
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/api/relay/voice`, { headers });
    this.ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      this.frames.push(frame);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(frame)) {
          clearTimeout(w.timer);
          w.resolve(frame);
          return false;
        }
        return true;
      });
    });
    this.ws.on('close', () => (this.closed = true));
  }

  waitFor(pred: (f: Frame) => boolean, ms = 2000): Promise<Frame> {
    const existing = this.frames.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for frame')), ms);
      this.waiters.push({ pred, resolve, timer });
    });
  }

  waitClose(ms = 2000): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for close')), ms);
      this.ws.on('close', () => (clearTimeout(timer), resolve()));
    });
  }

  send(frame: object): void {
    this.ws.send(JSON.stringify(frame));
  }
  close(): void {
    this.ws.close();
  }
}

const callId = (): string => randomBytes(24).toString('base64url');

describe('voice signaling (/api/relay/voice)', () => {
  it('greets an authenticated device and rejects an anonymous one', async () => {
    const alice = seedUser(t.db, { handle: 'Alice#0001' });
    const bearer = await enrollDevice(alice);
    const c = new VoiceClient(bearer);
    expect(await c.waitFor((f) => f.type === 'hello')).toEqual({ type: 'hello' });
    c.close();

    const anon = new VoiceClient(undefined);
    await anon.waitClose();
    expect(anon.frames).toHaveLength(0);
  });

  it('relays a sealed signal between two devices joined to the same call id', async () => {
    const alice = seedUser(t.db, { handle: 'Alice#0001' });
    const bob = seedUser(t.db, { handle: 'Bob#0002' });
    const a = new VoiceClient(await enrollDevice(alice));
    const b = new VoiceClient(await enrollDevice(bob));
    await a.waitFor((f) => f.type === 'hello');
    await b.waitFor((f) => f.type === 'hello');

    const id = callId();
    a.send({ type: 'join', callId: id });
    expect(await a.waitFor((f) => f.type === 'joined')).toMatchObject({ callId: id, peers: 0 });

    // Bob joins; Alice is told a peer joined, Bob sees one existing peer.
    b.send({ type: 'join', callId: id });
    expect(await b.waitFor((f) => f.type === 'joined')).toMatchObject({ callId: id, peers: 1 });
    expect(await a.waitFor((f) => f.type === 'peer-join')).toMatchObject({ callId: id });

    // Alice sends an (opaque) sealed offer; only Bob receives it.
    a.send({ type: 'signal', callId: id, payload: 'sealed-sdp-offer' });
    const got = await b.waitFor((f) => f.type === 'signal');
    expect(got).toMatchObject({ callId: id, payload: 'sealed-sdp-offer' });
    expect(a.frames.find((f) => f.type === 'signal')).toBeUndefined(); // not echoed to sender
    a.close();
    b.close();
  });

  it('does not relay a signal for a call the sender never joined', async () => {
    const alice = seedUser(t.db, { handle: 'Alice#0001' });
    const bob = seedUser(t.db, { handle: 'Bob#0002' });
    const a = new VoiceClient(await enrollDevice(alice));
    const b = new VoiceClient(await enrollDevice(bob));
    await a.waitFor((f) => f.type === 'hello');
    await b.waitFor((f) => f.type === 'hello');

    const id = callId();
    b.send({ type: 'join', callId: id });
    await b.waitFor((f) => f.type === 'joined');

    // Alice never joined `id`; her signal must be dropped, not forwarded to Bob.
    a.send({ type: 'signal', callId: id, payload: 'intrusion' });
    await expect(b.waitFor((f) => f.type === 'signal', 300)).rejects.toThrow();
    a.close();
    b.close();
  });

  it('notifies peers when a device leaves the call', async () => {
    const alice = seedUser(t.db, { handle: 'Alice#0001' });
    const bob = seedUser(t.db, { handle: 'Bob#0002' });
    const a = new VoiceClient(await enrollDevice(alice));
    const b = new VoiceClient(await enrollDevice(bob));
    await a.waitFor((f) => f.type === 'hello');
    await b.waitFor((f) => f.type === 'hello');

    const id = callId();
    a.send({ type: 'join', callId: id });
    await a.waitFor((f) => f.type === 'joined');
    b.send({ type: 'join', callId: id });
    await a.waitFor((f) => f.type === 'peer-join');

    // Explicit leave and hard disconnect both surface a peer-leave.
    b.send({ type: 'leave', callId: id });
    expect(await a.waitFor((f) => f.type === 'peer-leave')).toMatchObject({ callId: id });
    a.close();
    b.close();
  });

  it('caps a call room so a leaked call id cannot pack in extra listeners', async () => {
    const alice = seedUser(t.db, { handle: 'Alice#0001' });
    const bearer = await enrollDevice(alice);
    const id = callId();
    const clients: VoiceClient[] = [];
    for (let i = 0; i < 8; i++) {
      const c = new VoiceClient(bearer);
      await c.waitFor((f) => f.type === 'hello');
      c.send({ type: 'join', callId: id });
      await c.waitFor((f) => f.type === 'joined');
      clients.push(c);
    }
    const ninth = new VoiceClient(bearer);
    await ninth.waitFor((f) => f.type === 'hello');
    ninth.send({ type: 'join', callId: id });
    expect(await ninth.waitFor((f) => f.type === 'error')).toMatchObject({ error: 'call full' });
    for (const c of clients) c.close();
    ninth.close();
  });

  it('rejects a malformed (low-entropy) call id', async () => {
    const alice = seedUser(t.db, { handle: 'Alice#0001' });
    const a = new VoiceClient(await enrollDevice(alice));
    await a.waitFor((f) => f.type === 'hello');
    a.send({ type: 'join', callId: 'short' }); // fails CALL_ID_RE (min 8 chars)
    await expect(a.waitFor((f) => f.type === 'joined', 300)).rejects.toThrow();
    a.close();
  });
});
