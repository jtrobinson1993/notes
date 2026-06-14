import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectChatSocket, disconnectChatSocket, onConnect } from '../../src/lib/chatSocket';

// A controllable stand-in for the browser WebSocket so we can drive the
// open / message / close lifecycle deterministically.
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  url: string;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(): void {}
  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({});
  }
  // --- test drivers ---
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }
  message(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  serverClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({});
  }
}

const last = () => FakeWebSocket.instances.at(-1)!;

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  disconnectChatSocket(); // resets module singleton state (handlers, backoff, timers)
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('chatSocket backfill gating', () => {
  it('runs the backfill only after the server hello, not on raw open', () => {
    const onFrame = vi.fn();
    const backfill = vi.fn();
    onConnect(backfill);
    connectChatSocket(onFrame);

    last().open();
    expect(backfill).not.toHaveBeenCalled(); // open alone is not proof of a usable socket

    last().message({ type: 'hello', userId: 'me' });
    expect(backfill).toHaveBeenCalledTimes(1); // hello confirms it
    expect(onFrame).toHaveBeenCalledWith({ type: 'hello', userId: 'me' }); // frame still dispatched
  });

  it('an accepted-then-closed socket (no hello) never fires the backfill, even across reconnects', () => {
    vi.useFakeTimers();
    const backfill = vi.fn();
    onConnect(backfill);
    connectChatSocket(vi.fn());

    // Five accept→reject cycles (server closes the upgrade before any hello).
    for (let i = 0; i < 5; i++) {
      last().open();
      last().serverClose();
      vi.advanceTimersByTime(20_000); // let the scheduled reconnect (<=15s cap) fire
    }

    expect(backfill).not.toHaveBeenCalled(); // the regression: no crypto-heavy backfill storm
    expect(FakeWebSocket.instances.length).toBeGreaterThan(1); // it did keep retrying
  });

  it('backfills again on each genuinely re-confirmed reconnect', () => {
    vi.useFakeTimers();
    const backfill = vi.fn();
    onConnect(backfill);
    connectChatSocket(vi.fn());

    last().open();
    last().message({ type: 'hello', userId: 'me' });
    expect(backfill).toHaveBeenCalledTimes(1);

    last().serverClose();
    vi.advanceTimersByTime(1000); // reconnect
    last().open();
    last().message({ type: 'hello', userId: 'me' });
    expect(backfill).toHaveBeenCalledTimes(2);
  });
});
