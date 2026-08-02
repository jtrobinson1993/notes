// The app's real SfuControl: the webview's mediasoup-client can't hold the
// device token (keys stay in the Rust core), so its SFU control calls are
// proxied through Rust IPC (sfu_* commands → relay_client, device-token authed).
// Media/RTP flows webview↔SFU directly; only this control plane goes via IPC.
// In e2e the harness swaps in a REST-backed SfuControl instead.
import { invoke } from '@tauri-apps/api/core';
import type { SfuControl, SfuJoinResult } from './voiceMedia';

export const nativeSfuControl: SfuControl = {
  join: (callId) => invoke<SfuJoinResult>('sfu_join', { callId }),
  createTransport: (callId, direction) => invoke('sfu_transport', { callId, direction }),
  connectTransport: (callId, transportId, dtlsParameters) =>
    invoke('sfu_connect', { callId, transportId, dtlsParameters }),
  produce: (callId, transportId, rtpParameters) =>
    invoke<{ producerId: string }>('sfu_produce', { callId, transportId, rtpParameters }),
  consume: (callId, transportId, producerId, rtpCapabilities) =>
    invoke<{ id: string; rtpParameters: unknown }>('sfu_consume', {
      callId,
      transportId,
      producerId,
      rtpCapabilities,
    }),
  leave: (callId) => invoke('sfu_leave', { callId }),
};
