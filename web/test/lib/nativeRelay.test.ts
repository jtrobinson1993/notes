import { describe, expect, it, vi, beforeEach } from 'vitest';

// Hoisted mocks for the native IPC + the Tauri event bus.
const native = vi.hoisted(() => ({
  isNative: true,
  relayMailboxDrain: vi.fn(),
  relayConnect: vi.fn(),
  relayStatus: vi.fn(),
  settingsGet: vi.fn(),
  settingsSet: vi.fn(),
}));
vi.mock('../../src/lib/native', () => native);

const evt = vi.hoisted(() => ({
  handler: null as null | (() => void),
  unlisten: vi.fn(),
  listen: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, cb: () => void) => {
    evt.handler = cb;
    return evt.listen(name, cb);
  },
}));

import {
  drainMailbox,
  startRelayDelivery,
  stopRelayDelivery,
  setOnMailIngested,
  reconnectRelay,
  rememberRelayUrl,
} from '../../src/lib/nativeRelay';

const report = (ingested: number) => ({ ingested, acked: ingested, buffered: 0 });

beforeEach(() => {
  stopRelayDelivery(); // clear any listener leaked from a prior test
  vi.clearAllMocks();
  native.isNative = true;
  evt.handler = null;
  evt.listen.mockResolvedValue(evt.unlisten);
  setOnMailIngested(() => {});
});

describe('nativeRelay live delivery', () => {
  it('does nothing in the browser', async () => {
    native.isNative = false;
    await startRelayDelivery();
    await drainMailbox();
    expect(evt.listen).not.toHaveBeenCalled();
    expect(native.relayMailboxDrain).not.toHaveBeenCalled();
  });

  it('subscribes once and drains a backlog on start', async () => {
    native.relayMailboxDrain.mockResolvedValue(report(0));
    await startRelayDelivery();
    await startRelayDelivery(); // idempotent — no second listener
    expect(evt.listen).toHaveBeenCalledTimes(1);
    expect(evt.listen).toHaveBeenCalledWith('relay:mail', expect.any(Function));
    // one initial drain per start() call, but only one subscription
    expect(native.relayMailboxDrain).toHaveBeenCalledTimes(2);
  });

  it('drains when a relay:mail nudge fires', async () => {
    native.relayMailboxDrain.mockResolvedValue(report(0));
    await startRelayDelivery();
    native.relayMailboxDrain.mockClear();

    evt.handler!(); // simulate the nudge
    await vi.waitFor(() => expect(native.relayMailboxDrain).toHaveBeenCalledTimes(1));
  });

  it('fires the ingested hook only when rows were stored', async () => {
    const hook = vi.fn();
    setOnMailIngested(hook);
    native.relayMailboxDrain.mockResolvedValueOnce(report(0));
    await drainMailbox();
    expect(hook).not.toHaveBeenCalled();

    native.relayMailboxDrain.mockResolvedValueOnce(report(3));
    await drainMailbox();
    expect(hook).toHaveBeenCalledWith(report(3));
  });

  it('coalesces concurrent drains into one extra pass (no re-entrancy)', async () => {
    let resolveFirst!: () => void;
    // Pass 1 blocks until we release it; any later pass resolves immediately.
    native.relayMailboxDrain
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = () => r(report(0)))))
      .mockResolvedValue(report(0));

    const first = drainMailbox(); // enters, awaits the pending pass 1
    void drainMailbox(); // in-flight → schedules exactly one rerun
    void drainMailbox(); // in-flight → coalesces (still one rerun)
    expect(native.relayMailboxDrain).toHaveBeenCalledTimes(1);

    resolveFirst(); // finish pass 1 → the single rerun runs pass 2
    await first;
    expect(native.relayMailboxDrain).toHaveBeenCalledTimes(2);
  });

  it('swallows drain errors (best-effort)', async () => {
    native.relayMailboxDrain.mockRejectedValue(new Error('offline'));
    await expect(drainMailbox()).resolves.toBeUndefined();
  });

  it('stopRelayDelivery unsubscribes', async () => {
    native.relayMailboxDrain.mockResolvedValue(report(0));
    await startRelayDelivery();
    stopRelayDelivery();
    expect(evt.unlisten).toHaveBeenCalledTimes(1);
    // after stop, a fresh start re-subscribes
    await startRelayDelivery();
    expect(evt.listen).toHaveBeenCalledTimes(2);
  });
});

describe('nativeRelay reconnect-on-boot', () => {
  it('redials the remembered relay then starts delivery when not connected', async () => {
    native.relayStatus.mockResolvedValue({ connected: false, base_url: null, relay_fp: null });
    native.settingsGet.mockResolvedValue('https://relay.example');
    native.relayConnect.mockResolvedValue(undefined);
    native.relayMailboxDrain.mockResolvedValue(report(0));

    await reconnectRelay();
    expect(native.relayConnect).toHaveBeenCalledWith('https://relay.example');
    expect(evt.listen).toHaveBeenCalledTimes(1); // delivery started
  });

  it('skips the redial but still ensures delivery when already connected', async () => {
    native.relayStatus.mockResolvedValue({
      connected: true,
      base_url: 'https://relay.example',
      relay_fp: 'fp',
    });
    native.relayMailboxDrain.mockResolvedValue(report(0));

    await reconnectRelay();
    expect(native.relayConnect).not.toHaveBeenCalled();
    expect(native.settingsGet).not.toHaveBeenCalled();
    expect(evt.listen).toHaveBeenCalledTimes(1);
  });

  it('no-ops when no relay was ever remembered', async () => {
    native.relayStatus.mockResolvedValue({ connected: false, base_url: null, relay_fp: null });
    native.settingsGet.mockResolvedValue(null);

    await reconnectRelay();
    expect(native.relayConnect).not.toHaveBeenCalled();
    expect(evt.listen).not.toHaveBeenCalled();
  });

  it('swallows a failed redial (retries on the next unlock)', async () => {
    native.relayStatus.mockResolvedValue({ connected: false, base_url: null, relay_fp: null });
    native.settingsGet.mockResolvedValue('https://relay.example');
    native.relayConnect.mockRejectedValue(new Error('offline'));

    await expect(reconnectRelay()).resolves.toBeUndefined();
    expect(evt.listen).not.toHaveBeenCalled(); // delivery not started
  });

  it('rememberRelayUrl persists the url', async () => {
    native.settingsSet.mockResolvedValue(undefined);
    await rememberRelayUrl('https://relay.example');
    expect(native.settingsSet).toHaveBeenCalledWith('relay.url', 'https://relay.example');
  });
});
