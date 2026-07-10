import { describe, expect, it, vi } from 'vitest';
import { createCallMedia, type MsDevice, type MsTransport, type SfuControl } from '../../src/lib/voiceMedia';

type ConnectHandler = (a: { dtlsParameters: unknown }, cb: () => void, eb: (e: unknown) => void) => void;
type ProduceHandler = (a: { rtpParameters: unknown }, cb: (r: { id: string }) => void, eb: (e: unknown) => void) => void;

function fakeTransport(id: string): MsTransport & { fireConnect(): void; fireProduce(): Promise<string> } {
  let onConnect: ConnectHandler | undefined;
  let onProduce: ProduceHandler | undefined;
  return {
    id,
    on(event: string, h: unknown) {
      if (event === 'connect') onConnect = h as ConnectHandler;
      else onProduce = h as ProduceHandler;
    },
    produce: vi.fn(async () => ({ rtpSender: {} as RTCRtpSender })),
    consume: vi.fn(async (o: { producerId: string }) => ({
      track: { id: `track-${o.producerId}` } as unknown as MediaStreamTrack,
      rtpReceiver: {} as RTCRtpReceiver,
    })),
    close: vi.fn(),
    fireConnect() {
      onConnect?.({ dtlsParameters: { d: 1 } }, () => {}, () => {});
    },
    async fireProduce() {
      return new Promise<string>((resolve) => onProduce?.({ rtpParameters: { r: 1 } }, (res) => resolve(res.id), () => {}));
    },
  };
}

function harness(joinPeers: { participantId: string; producerId: string | null }[] = []) {
  const send = fakeTransport('send-t');
  const recv = fakeTransport('recv-t');
  const control: SfuControl = {
    join: vi.fn(async () => ({ routerRtpCapabilities: { codecs: [] }, peers: joinPeers })),
    createTransport: vi.fn(async (_c, d) => ({ id: `${d}-params` })),
    connectTransport: vi.fn(async () => {}),
    produce: vi.fn(async () => ({ producerId: 'my-producer' })),
    consume: vi.fn(async (_c, _t, producerId) => ({ id: `consumer-${producerId}`, rtpParameters: {} })),
    leave: vi.fn(async () => {}),
  };
  const device: MsDevice = {
    load: vi.fn(async () => {}),
    rtpCapabilities: { caps: true },
    createSendTransport: () => send,
    createRecvTransport: () => recv,
  };
  const remoteTracks: string[] = [];
  const encryptSender = vi.fn();
  const decryptReceiver = vi.fn();
  const media = createCallMedia({
    control,
    createDevice: () => device,
    getMicTrack: async () => ({ stop: vi.fn() }) as unknown as MediaStreamTrack,
    onRemoteTrack: (t) => remoteTracks.push(t.id),
    encryptSender,
    decryptReceiver,
  });
  return { media, control, device, send, recv, remoteTracks, encryptSender, decryptReceiver };
}

describe('createCallMedia (SFU orchestration)', () => {
  it('joins: loads the device, makes both transports, produces the mic (encrypted)', async () => {
    const h = harness();
    await h.media.join('call-1');
    expect(h.control.join).toHaveBeenCalledWith('call-1');
    expect(h.device.load).toHaveBeenCalledWith({ routerRtpCapabilities: { codecs: [] } });
    expect(h.control.createTransport).toHaveBeenCalledWith('call-1', 'send');
    expect(h.control.createTransport).toHaveBeenCalledWith('call-1', 'recv');
    expect(h.send.produce).toHaveBeenCalled();
    expect(h.encryptSender).toHaveBeenCalledTimes(1); // frame E2EE on the sender
  });

  it('wires transport connect + produce events to the control plane', async () => {
    const h = harness();
    await h.media.join('call-1');
    h.send.fireConnect();
    await Promise.resolve();
    expect(h.control.connectTransport).toHaveBeenCalledWith('call-1', 'send-t', { dtlsParameters: { d: 1 } }.dtlsParameters);
    const producerId = await h.send.fireProduce();
    expect(h.control.produce).toHaveBeenCalledWith('call-1', 'send-t', { r: 1 });
    expect(producerId).toBe('my-producer'); // server producer id flows back to the transport
  });

  it('consumes a peer already producing at join time (decrypted)', async () => {
    const h = harness([{ participantId: 'p1', producerId: 'peer-prod-1' }]);
    await h.media.join('call-1');
    expect(h.control.consume).toHaveBeenCalledWith('call-1', 'recv-t', 'peer-prod-1', { caps: true });
    expect(h.recv.consume).toHaveBeenCalled();
    expect(h.decryptReceiver).toHaveBeenCalledTimes(1);
    expect(h.remoteTracks).toEqual(['track-peer-prod-1']);
  });

  it('consumes a later producer on the producer signal, and dedups', async () => {
    const h = harness();
    await h.media.join('call-1');
    await h.media.onProducer('late-prod');
    await h.media.onProducer('late-prod'); // duplicate signal → ignored
    expect(h.control.consume).toHaveBeenCalledTimes(1);
    expect(h.remoteTracks).toEqual(['track-late-prod']);
  });

  it('close releases transports + mic and leaves the SFU room', async () => {
    const h = harness();
    await h.media.join('call-1');
    h.media.close();
    expect(h.send.close).toHaveBeenCalled();
    expect(h.recv.close).toHaveBeenCalled();
    expect(h.control.leave).toHaveBeenCalledWith('call-1');
  });
});
