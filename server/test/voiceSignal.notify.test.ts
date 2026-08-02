import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { createVoiceSignal, type VoiceSignal } from '../src/voiceSignal.js';

let app: FastifyInstance;
let vs: VoiceSignal;
let port: number;

beforeEach(async () => {
  app = Fastify();
  await app.register(fastifyWebsocket);
  vs = createVoiceSignal();
  // Stub auth: the bearer token *is* the device id (so tokens = device ids).
  vs.register(app, (token) => token, 1000);
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
});
afterEach(() => app.close());

interface Frame {
  type?: string;
  callId?: string;
  payload?: unknown;
}

class Client {
  ws: WebSocket;
  frames: Frame[] = [];
  private waiters: { pred: (f: Frame) => boolean; resolve: (f: Frame) => void; timer: NodeJS.Timeout }[] = [];
  constructor(bearer: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/api/relay/voice`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    this.ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString()) as Frame;
      this.frames.push(f);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(f)) {
          clearTimeout(w.timer);
          w.resolve(f);
          return false;
        }
        return true;
      });
    });
  }
  waitFor(pred: (f: Frame) => boolean, ms = 2000): Promise<Frame> {
    const hit = this.frames.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), ms);
      this.waiters.push({ pred, resolve, timer });
    });
  }
  send(f: object): void {
    this.ws.send(JSON.stringify(f));
  }
  close(): void {
    this.ws.close();
  }
}

describe('VoiceSignal.notifyRoom (SFU → signaling-room push)', () => {
  it('pushes a frame to every device in the call, honouring an exclusion', async () => {
    const a = new Client('devA');
    const b = new Client('devB');
    await a.waitFor((f) => f.type === 'hello');
    await b.waitFor((f) => f.type === 'hello');
    a.send({ type: 'join', callId: 'call-room-1' });
    b.send({ type: 'join', callId: 'call-room-1' });
    await a.waitFor((f) => f.type === 'joined');
    await b.waitFor((f) => f.type === 'joined');

    // Broadcast to the whole room → both receive.
    vs.notifyRoom('call-room-1', { type: 'signal', callId: 'call-room-1', payload: { kind: 'producer', producerId: 'p1' } });
    const fa = await a.waitFor((f) => f.type === 'signal');
    const fb = await b.waitFor((f) => f.type === 'signal');
    expect((fa.payload as { producerId: string }).producerId).toBe('p1');
    expect((fb.payload as { producerId: string }).producerId).toBe('p1');

    // Exclude devA (the producer) → only devB gets the second one.
    vs.notifyRoom('call-room-1', { type: 'signal', callId: 'call-room-1', payload: { kind: 'producer', producerId: 'p2' } }, 'devA');
    const gotB = await b.waitFor((f) => f.type === 'signal' && (f.payload as { producerId: string }).producerId === 'p2');
    expect(gotB).toBeTruthy();
    // devA must NOT receive p2.
    await new Promise((r) => setTimeout(r, 150));
    expect(a.frames.some((f) => f.type === 'signal' && (f.payload as { producerId?: string }).producerId === 'p2')).toBe(false);

    a.close();
    b.close();
  });

  it('is a no-op for an unknown call room', () => {
    expect(() => vs.notifyRoom('no-such-room', { type: 'signal' })).not.toThrow();
  });
});
