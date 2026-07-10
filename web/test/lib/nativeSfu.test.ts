import { describe, expect, it, vi, beforeEach } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { nativeSfuControl } from '../../src/lib/nativeSfu';

beforeEach(() => {
  vi.clearAllMocks();
  invoke.mockResolvedValue({});
});

describe('nativeSfuControl (Rust-IPC-proxied SFU control)', () => {
  it('maps each control call to its sfu_* command with camelCase args', async () => {
    await nativeSfuControl.join('call-1');
    expect(invoke).toHaveBeenCalledWith('sfu_join', { callId: 'call-1' });

    await nativeSfuControl.createTransport('call-1', 'send');
    expect(invoke).toHaveBeenCalledWith('sfu_transport', { callId: 'call-1', direction: 'send' });

    await nativeSfuControl.connectTransport('call-1', 't1', { dtls: 1 });
    expect(invoke).toHaveBeenCalledWith('sfu_connect', { callId: 'call-1', transportId: 't1', dtlsParameters: { dtls: 1 } });

    await nativeSfuControl.produce('call-1', 't1', { rtp: 1 });
    expect(invoke).toHaveBeenCalledWith('sfu_produce', { callId: 'call-1', transportId: 't1', rtpParameters: { rtp: 1 } });

    await nativeSfuControl.consume('call-1', 'r1', 'prod-9', { caps: 1 });
    expect(invoke).toHaveBeenCalledWith('sfu_consume', {
      callId: 'call-1',
      transportId: 'r1',
      producerId: 'prod-9',
      rtpCapabilities: { caps: 1 },
    });

    await nativeSfuControl.leave('call-1');
    expect(invoke).toHaveBeenCalledWith('sfu_leave', { callId: 'call-1' });
  });

  it('returns the resolved value from produce (producerId)', async () => {
    invoke.mockResolvedValueOnce({ producerId: 'p-42' });
    expect(await nativeSfuControl.produce('c', 't', {})).toEqual({ producerId: 'p-42' });
  });
});
